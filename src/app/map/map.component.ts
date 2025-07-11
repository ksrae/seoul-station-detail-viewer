import { Component, ElementRef, OnInit, ViewChild, signal, effect, Renderer2, OnDestroy, AfterViewInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

interface StationImage {
  line: string;
  lineNumber: string;
  imageUrl: string;
}

interface LineInfo {
  line: string;
  lineNumber: string;
}

interface StationInfo {
  id: string;
  isTransfer?: boolean;
  lines?: LineInfo[];
  imageUrl?: string;  // 기존 단일 이미지 지원 (하위 호환성)
  images?: StationImage[];  // 새로운 다중 이미지 배열
  description?: string;
}

type SubwayDatabase = StationInfo[];

interface StationPin {
  element: SVGTextElement;
  name: string;
}

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './map.component.html',
  styleUrls: ['./map.component.scss']
})
export class MapComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('searchInputElement') searchInputElement?: ElementRef<HTMLInputElement>;

  // 상태 관리
  selectedStation = signal<StationInfo | null>(null);
  stationImageUrl = signal<string | ''>('');
  imageExists = signal(false);
  imageError = signal<string | null>(null);
  isImageViewerVisible = signal(false);

  // 이미지 캐러셀 관련 시그널 추가
  currentImageIndex = signal(0);
  stationImages = signal<StationImage[]>([]);
  currentStationImage = signal<StationImage | null>(null);

  // 검색 관련
  searchQuery = signal('');
  searchInput = signal('');
  private searchedStations = signal<StationPin[]>([]);
  currentSearchIndex = signal(-1);

  // 로딩 상태
  isLoading = signal(true);
  loadingProgress = signal(0);
  databaseLoadError = signal<string | null>(null);

  // 데이터베이스 및 좌표 저장소
  private stationDatabase: SubwayDatabase = [];
  private stationPins: StationPin[] = [];

  // SVG 맵 관련
  private svgElement: SVGSVGElement | null = null;
  private isPanning = false;
  private isAnimating = false;
  private startPoint = { x: 0, y: 0 };

  private readonly initialWidth = 5724;
  private readonly initialHeight = 6516;
  private defaultViewBox = { x: 0, y: 0, w: this.initialWidth, h: this.initialHeight };
  private viewBox = { ...this.defaultViewBox };

  // 줌 설정
  private maxZoom = 5;
  private minZoom = 0.3;

  // 터치 관련
  private touchStartDistance = 0;
  private lastTouchPoint = { x: 0, y: 0 };
  private lastTouchTime = 0;

  // 하이라이트 관리
  private currentHighlightedText: SVGTextElement | null = null;
  private unlistenFunctions: (() => void)[] = [];
  private isInitialized = false;
  private isLoadingData = false;

  // 디버그용 시그널 변수
  debugCenterX = signal(0);
  debugCenterY = signal(0);

  private transformOffset = { x: 0, y: 0 };
  private isOffsetCalculated = false;
  private isDragging = false;
  private dragThreshold = 5; // 5픽셀 이상 움직이면 드래그로 간주

  constructor(
    private http: HttpClient,
    private renderer: Renderer2
  ) {
    effect(() => {
      const station = this.selectedStation();
      if (station) {
        this.imageError.set(null);
        this.currentImageIndex.set(0);

        // 이미지 배열 설정 (새 형식과 기존 형식 모두 지원)
        const images: StationImage[] = [];

        if (station.images && station.images.length > 0) {
          // 새로운 형식: images 배열 사용
          images.push(...station.images);
        } else if (station.imageUrl) {
          // 기존 형식: 단일 imageUrl 사용 (하위 호환성)
          // 첫 번째 호선의 이미지로 간주
          const firstLine = station.lines?.[0] || { line: "정보없음", lineNumber: "0" };
          images.push({
            line: firstLine.line,
            lineNumber: firstLine.lineNumber,
            imageUrl: station.imageUrl
          });
        }

        if (images.length > 0) {
          this.stationImages.set(images);
          this.currentStationImage.set(images[0]);
          this.checkAndSetImageUrl(images[0]);
        } else {
          this.stationImages.set([]);
          this.currentStationImage.set(null);
          this.stationImageUrl.set('');
          this.imageExists.set(false);
          this.imageError.set('이 역에 등록된 이미지가 없습니다.');
        }
      }
    });
  }

  async ngOnInit(): Promise<void> {
    if (this.isInitialized) return;
    this.isLoading.set(true);
    this.isLoadingData = true;
    try {
      this.loadingProgress.set(0);
      await this.loadStationDatabase();
      this.loadingProgress.set(33);
      await this.loadSvgMap();
      this.loadingProgress.set(66);
    } catch (error) {
      console.error('초기화 중 오류 발생:', error);
      this.databaseLoadError.set('초기화 중 오류가 발생했습니다.');
    }
  }

  ngAfterViewInit(): void {
    const observer = new MutationObserver(() => {
      if (this.mapContainer.nativeElement.querySelector('svg') && !this.isInitialized) {
        this.setupMap();
        this.loadingProgress.set(100);
        this.isInitialized = true;
        this.isLoading.set(false);
        this.isLoadingData = false;
        observer.disconnect();
      }
    });
    observer.observe(this.mapContainer.nativeElement, { childList: true });
  }

  ngOnDestroy(): void {
    if (this.currentHighlightedText) {
      this.renderer.removeClass(this.currentHighlightedText, 'station-highlight');
    }
    this.searchedStations().forEach(pin => {
      this.renderer.removeClass(pin.element, 'station-search-highlight');
      this.renderer.removeClass(pin.element, 'current-search-result');
    });
    this.unlistenFunctions.forEach(unlisten => unlisten());
  }

  private async loadStationDatabase(): Promise<void> {
    try {
      this.stationDatabase = await firstValueFrom(this.http.get<SubwayDatabase>('/data/stations.json'));
    } catch (error) {
      this.databaseLoadError.set('역 정보를 불러오는데 실패했습니다.');
    }
  }

  private async loadSvgMap(): Promise<void> {
    try {
      const svgData = await firstValueFrom(this.http.get('/metro.svg', { responseType: 'text' }));
      this.mapContainer.nativeElement.innerHTML = svgData;
    } catch (error) {
      this.databaseLoadError.set('지도를 불러오는데 실패했습니다.');
    }
  }

  private calculateTransformOffset(): void {
    if (this.isOffsetCalculated || !this.svgElement) return;
    this.transformOffset = { x: 0, y: 0 };
    this.isOffsetCalculated = true;
  }



  private setupMap(): void {
    this.svgElement = this.mapContainer.nativeElement.querySelector('svg');
    if (!this.svgElement) return;

    const viewBoxAttr = this.svgElement.getAttribute('viewBox');
    if (viewBoxAttr) {
      const [x, y, w, h] = viewBoxAttr.split(' ').map(Number);
      this.defaultViewBox = { x, y, w, h };
      this.viewBox = { ...this.defaultViewBox };
    }

    this.updateViewBox();
    this.cacheStationPins();

    // SVG 텍스트 요소들의 초기 상태 확인 및 수정
    this.stationPins.forEach(pin => {
      const computedStyle = window.getComputedStyle(pin.element);
      const fill = pin.element.getAttribute('fill') || computedStyle.fill;

      // 투명하거나 보이지 않는 텍스트 수정
      if (!fill ||
          fill === 'none' ||
          fill === 'transparent' ||
          fill === 'rgba(0, 0, 0, 0)' ||
          computedStyle.opacity === '0' ||
          computedStyle.visibility === 'hidden') {

        console.warn(`투명한 역 발견: ${pin.name}`, {
          fill: fill,
          opacity: computedStyle.opacity,
          visibility: computedStyle.visibility
        });

        // 기본값으로 설정
        pin.element.setAttribute('fill', '#333333');
        pin.element.style.opacity = '1';
        pin.element.style.visibility = 'visible';
      }
    });

    this.calculateTransformOffset();
    this.setupEventListeners();
  }

  private ensureTextVisible(element: SVGTextElement): void {
    const computedStyle = window.getComputedStyle(element);

    // 현재 상태 확인
    const currentFill = element.getAttribute('fill') || computedStyle.fill;
    const currentOpacity = computedStyle.opacity;
    const currentVisibility = computedStyle.visibility;

    // 보이지 않는 경우 강제로 보이도록 설정
    if (currentOpacity === '0' || currentVisibility === 'hidden' ||
        !currentFill || currentFill === 'none' || currentFill === 'transparent') {

      element.style.setProperty('fill', '#333333', 'important');
      element.style.setProperty('opacity', '1', 'important');
      element.style.setProperty('visibility', 'visible', 'important');
    }
  }

  private cacheStationPins(): void {
    if (!this.svgElement) return;
    const allTextElements = this.svgElement.querySelectorAll('text');
    allTextElements.forEach(textEl => {
      const stationName = textEl.textContent?.trim();
      if (stationName && stationName.length >= 2) {
        this.stationPins.push({ element: textEl, name: stationName });
      }
    });
  }

private setupEventListeners(): void {
  if (!this.svgElement) return;
  const eventListeners = [
    { event: 'wheel', handler: this.onWheel.bind(this), options: { passive: false } },
    { event: 'mousedown', handler: this.onMouseDown.bind(this) },
    { event: 'mousemove', handler: this.onMouseMove.bind(this), target: document },
    { event: 'mouseup', handler: this.onMouseUp.bind(this), target: document },
    { event: 'touchstart', handler: this.onTouchStart.bind(this), options: { passive: false } },
    { event: 'touchmove', handler: this.onTouchMove.bind(this), options: { passive: false } },
    { event: 'touchend', handler: this.onTouchEnd.bind(this) }
  ];
  eventListeners.forEach(({ event, handler, target = this.mapContainer.nativeElement, options = {} }) => {
    this.unlistenFunctions.push(this.renderer.listen(target, event, handler, options));
  });

  this.stationPins.forEach(pin => {
    this.unlistenFunctions.push(
      this.renderer.listen(pin.element, 'mouseenter', () => {
        this.playHoverAnimation(pin.element, true);
        if (pin.element.classList.contains('station-search-highlight')) {
          console.log(`검색된 역 hover: ${pin.name}`);
        }
      }),
      this.renderer.listen(pin.element, 'mouseleave', () => {
        this.playHoverAnimation(pin.element, false);
      }),
      this.renderer.listen(pin.element, 'click', (event: MouseEvent) => {
        event.stopPropagation();

        // 드래그 중이면 클릭 이벤트 무시
        if (this.isDragging) {
          this.isDragging = false;
          return;
        }

        // 역 정보만 표시하고 이동하지 않음
        this.handleStationClick(pin.name);
        // focusOnStation 호출 제거 - 클릭 시 이동하지 않음
      })
    );
  });
}

  private getElementPosition(element: SVGGraphicsElement): { x: number; y: number } {
    if (!this.svgElement) return { x: 0, y: 0 };

    try {
      const transform = element.getAttribute('transform');

      if (transform && transform.includes('matrix')) {
        const match = transform.match(/[\d.-]+/g);

        if (match && match.length >= 6) {
          const transformX = parseFloat(match[4]);
          const transformY = parseFloat(match[5]);

          return {
            x: transformX,
            y: transformY
          };
        }
      }

      return { x: 0, y: 0 };

    } catch (error) {
      console.error('위치 계산 오류:', error);
      return { x: 0, y: 0 };
    }
  }

  executeSearch(): void {
    const searchTerm = this.searchInput().trim();
    if (!searchTerm) { this.clearSearch(); return; }
    this.performSearch(searchTerm);
  }

  onSearchEnter(event: Event): void {
    event.preventDefault();
    const currentInput = this.searchInput().trim();
    if (!currentInput) { this.clearSearch(); return; }
    if (this.searchQuery() !== currentInput || this.searchedStations().length === 0) {
      this.performSearch(currentInput);
    } else if (this.searchedStations().length > 1) {
      this.navigateToNextSearchResult();
    }
  }

  private performSearch(searchTerm: string): void {
    this.searchQuery.set(searchTerm);
    const query = searchTerm.toLowerCase();

    if (!query) {
      this.searchedStations.set([]);
      this.currentSearchIndex.set(-1);
      this.highlightSearchResults();
      return;
    }

    const foundStations = this.stationPins.filter(pin =>
      pin.name.toLowerCase().includes(query)
    );

    // 검색된 역들이 확실히 보이도록 처리
    foundStations.forEach(station => {
      this.ensureTextVisible(station.element);
    });

    this.searchedStations.set(foundStations);

    if (foundStations.length > 0) {
      this.currentSearchIndex.set(0);
      this.focusOnStation(foundStations[0].element, true);
    } else {
      this.currentSearchIndex.set(-1);
    }

    this.highlightSearchResults();
  }

  private highlightSearchResults(): void {
    // 먼저 모든 역의 클래스와 인라인 스타일 초기화
    this.stationPins.forEach(pin => {
      this.renderer.removeClass(pin.element, 'station-search-highlight');
      this.renderer.removeClass(pin.element, 'current-search-result');

      // 인라인 스타일 제거 (클래스로만 제어)
      this.renderer.removeStyle(pin.element, 'fill');
      this.renderer.removeStyle(pin.element, 'opacity');
      this.renderer.removeStyle(pin.element, 'visibility');
    });

    const stations = this.searchedStations();

    // 검색된 역들에 하이라이트 적용
    stations.forEach((pin, index) => {
      // 원본 fill 색상 보존
      const originalFill = pin.element.getAttribute('fill') ||
                          window.getComputedStyle(pin.element).fill ||
                          '#333333';

      // data 속성에 원본 색상 저장
      if (!pin.element.hasAttribute('data-original-fill')) {
        pin.element.setAttribute('data-original-fill', originalFill);
      }

      // 검색 하이라이트 클래스 추가
      this.renderer.addClass(pin.element, 'station-search-highlight');

      // 강제로 보이도록 인라인 스타일 설정
      this.renderer.setStyle(pin.element, 'opacity', '1');
      this.renderer.setStyle(pin.element, 'visibility', 'visible');

      // fill이 none, transparent, 또는 흰색인 경우 강제로 색상 설정
      if (originalFill === 'none' ||
          originalFill === 'transparent' ||
          originalFill === 'rgba(0, 0, 0, 0)' ||
          originalFill === '#ffffff' ||
          originalFill === 'rgb(255, 255, 255)') {
        this.renderer.setStyle(pin.element, 'fill', '#333333');
      }

      // 현재 선택된 검색 결과인 경우
      if (index === this.currentSearchIndex()) {
        this.renderer.addClass(pin.element, 'current-search-result');
      }

      // 부모 요소들도 확인하여 보이도록 설정 - 타입 수정
      let parent: Element | null = pin.element.parentElement;
      while (parent && parent !== this.svgElement as Element) {
        const parentOpacity = window.getComputedStyle(parent).opacity;
        const parentVisibility = window.getComputedStyle(parent).visibility;

        if (parentOpacity === '0' || parentVisibility === 'hidden') {
          this.renderer.setStyle(parent, 'opacity', '1');
          this.renderer.setStyle(parent, 'visibility', 'visible');
        }

        parent = parent.parentElement;
      }
    });

    // 디버깅: 검색 결과 상태 확인
    if (stations.length > 0) {
      console.log('검색 하이라이트 적용됨:', {
        검색결과수: stations.length,
        첫번째역: {
          이름: stations[0].name,
          fill: stations[0].element.getAttribute('fill'),
          computedFill: window.getComputedStyle(stations[0].element).fill,
          opacity: window.getComputedStyle(stations[0].element).opacity,
          visibility: window.getComputedStyle(stations[0].element).visibility,
          클래스: stations[0].element.className.baseVal
        }
      });
    }
  }

  navigateToNextSearchResult(): void {
    const stations = this.searchedStations();
    if (stations.length === 0) return;
    const nextIndex = (this.currentSearchIndex() + 1) % stations.length;
    this.currentSearchIndex.set(nextIndex);
    this.highlightSearchResults();
    const stationToFocus = stations[nextIndex];
    this.focusOnStation(stationToFocus.element, true);
    this.searchInputElement?.nativeElement.focus();
  }

  clearSearch(): void {
    this.searchInput.set('');
    this.searchQuery.set('');
    this.searchedStations.set([]);
    this.currentSearchIndex.set(-1);

    // 모든 역의 하이라이트 제거 및 원본 상태 복원
    this.stationPins.forEach(pin => {
      this.renderer.removeClass(pin.element, 'station-search-highlight');
      this.renderer.removeClass(pin.element, 'current-search-result');

      // 인라인 스타일 제거
      this.renderer.removeStyle(pin.element, 'fill');
      this.renderer.removeStyle(pin.element, 'opacity');
      this.renderer.removeStyle(pin.element, 'visibility');

      // 원본 fill 복원
      const originalFill = pin.element.getAttribute('data-original-fill');
      if (originalFill) {
        pin.element.setAttribute('fill', originalFill);
        pin.element.removeAttribute('data-original-fill');
      }
    });
  }

private focusOnStation(textElement: SVGTextElement, animate: boolean = false, resetZoom: boolean = true): void {
  if (!this.svgElement) return;

  const position = this.getElementPosition(textElement);

  // 검색인 경우 줌을 1로, 아니면 현재 줌 유지
  let targetWidth = this.viewBox.w;
  let targetHeight = this.viewBox.h;

  if (resetZoom) {
    targetWidth = this.defaultViewBox.w;
    targetHeight = this.defaultViewBox.h;
  }

  // 하드코딩된 오프셋 유지
  const offsetX = -563;
  const offsetY = -666;
  const targetX = position.x + offsetX;
  const targetY = position.y + offsetY;

  if (animate) {
    this.animateViewBox(targetX, targetY, targetWidth, targetHeight);
  } else {
    this.viewBox = { x: targetX, y: targetY, w: targetWidth, h: targetHeight };
    this.updateViewBox();
  }
}

// animateViewBox는 그대로 유지
private animateViewBox(targetX: number, targetY: number, targetW: number, targetH: number): void {
  this.isAnimating = true;

  const duration = 500;
  const startTime = Date.now();
  const { x: startX, y: startY, w: startW, h: startH } = this.viewBox;

  const animate = () => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);

    const newX = startX + (targetX - startX) * eased;
    const newY = startY + (targetY - startY) * eased;
    const newW = startW + (targetW - startW) * eased;
    const newH = startH + (targetH - startH) * eased;

    this.viewBox.x = newX;
    this.viewBox.y = newY;
    this.viewBox.w = newW;
    this.viewBox.h = newH;

    this.updateViewBox();

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      this.isAnimating = false;
    }
  };
  animate();
}

  // 이미지 URL 체크 메서드 수정
  private checkAndSetImageUrl(stationImage: StationImage | null): void {
    if (stationImage && stationImage.imageUrl) {
      const img = new Image();
      img.onload = () => {
        this.stationImageUrl.set(stationImage.imageUrl);
        this.imageExists.set(true);
        this.imageError.set(null);
      };
      img.onerror = () => {
        this.stationImageUrl.set('');
        this.imageExists.set(false);
        this.imageError.set('이미지를 찾을 수 없습니다.');
      };
      img.src = stationImage.imageUrl;
    } else {
      this.stationImageUrl.set('');
      this.imageExists.set(false);
      this.imageError.set('이 역에 등록된 이미지가 없습니다.');
    }
  }

  // 이전 이미지로 이동
  previousImage(): void {
    const images = this.stationImages();
    if (images.length <= 1) return;

    const currentIndex = this.currentImageIndex();
    const newIndex = currentIndex > 0 ? currentIndex - 1 : images.length - 1;
    this.currentImageIndex.set(newIndex);
    this.currentStationImage.set(images[newIndex]);
    this.checkAndSetImageUrl(images[newIndex]);
  }

  // 다음 이미지로 이동
  nextImage(): void {
    const images = this.stationImages();
    if (images.length <= 1) return;

    const currentIndex = this.currentImageIndex();
    const newIndex = currentIndex < images.length - 1 ? currentIndex + 1 : 0;
    this.currentImageIndex.set(newIndex);
    this.currentStationImage.set(images[newIndex]);
    this.checkAndSetImageUrl(images[newIndex]);
  }

  // 특정 이미지로 이동
  goToImage(index: number): void {
    const images = this.stationImages();
    if (index >= 0 && index < images.length) {
      this.currentImageIndex.set(index);
      this.currentStationImage.set(images[index]);
      this.checkAndSetImageUrl(images[index]);
    }
  }

  // 키보드 네비게이션 지원
  handleKeyboardNavigation(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      this.previousImage();
    } else if (event.key === 'ArrowRight') {
      this.nextImage();
    }
  }

  private onWheel(event: WheelEvent): void {
    if (this.isAnimating) return;
    event.preventDefault();
    if (!this.svgElement) return;
    const zoomIntensity = 0.1;
    const scaleFactor = event.deltaY > 0 ? 1 + zoomIntensity : 1 - zoomIntensity;
    const newWidth = this.viewBox.w * scaleFactor;
    const newZoom = this.defaultViewBox.w / newWidth;
    if (newZoom > this.maxZoom || newZoom < this.minZoom) return;
    const mousePoint = this.getSVGPoint(event.clientX, event.clientY);
    this.viewBox.x = mousePoint.x - (mousePoint.x - this.viewBox.x) * scaleFactor;
    this.viewBox.y = mousePoint.y - (mousePoint.y - this.viewBox.y) * scaleFactor;
    this.viewBox.w = newWidth;
    this.viewBox.h = this.viewBox.h * scaleFactor;
    this.updateViewBox();
  }

private onMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || !(event.target as HTMLElement).closest('svg')) return;
  this.isPanning = true;
  this.isDragging = false; // 드래그 상태 초기화
  this.startPoint = { x: event.clientX, y: event.clientY };
  if (this.svgElement) this.renderer.setStyle(this.svgElement, 'cursor', 'grabbing');
}

private onMouseMove(event: MouseEvent): void {
  if (this.isAnimating) return;
  if (!this.isPanning || !this.svgElement) return;

  // 드래그 거리 계산
  const distance = Math.hypot(
    event.clientX - this.startPoint.x,
    event.clientY - this.startPoint.y
  );

  // 임계값을 넘으면 드래그로 간주
  if (distance > this.dragThreshold) {
    this.isDragging = true;
  }

  const scale = this.viewBox.w / this.svgElement.clientWidth;
  const dx = (event.clientX - this.startPoint.x) * scale;
  const dy = (event.clientY - this.startPoint.y) * scale;
  this.viewBox.x -= dx;
  this.viewBox.y -= dy;
  this.updateViewBox();
  this.startPoint = { x: event.clientX, y: event.clientY };
}

private onMouseUp(): void {
  this.isPanning = false;
  if (this.svgElement) this.renderer.setStyle(this.svgElement, 'cursor', 'grab');
}

private onTouchStart(event: TouchEvent): void {
  event.preventDefault();
  this.isDragging = false; // 드래그 상태 초기화
  const currentTime = new Date().getTime();
  if (currentTime - this.lastTouchTime < 300 && event.touches.length === 1) {
    this.handleDoubleTap(event.touches[0].clientX, event.touches[0].clientY);
  }
  this.lastTouchTime = currentTime;
  if (event.touches.length === 1) {
    this.isPanning = true;
    this.lastTouchPoint = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  } else if (event.touches.length === 2) {
    this.isPanning = false;
    this.touchStartDistance = this.getTouchDistance(event.touches);
  }
}

private onTouchMove(event: TouchEvent): void {
  if (!this.svgElement) return;

  // 터치 드래그 감지
  if (event.touches.length === 1 && this.isPanning) {
    const touch = event.touches[0];
    const distance = Math.hypot(
      touch.clientX - this.lastTouchPoint.x,
      touch.clientY - this.lastTouchPoint.y
    );

    if (distance > this.dragThreshold) {
      this.isDragging = true;
    }

    const scale = this.viewBox.w / this.svgElement.clientWidth;
    const dx = (touch.clientX - this.lastTouchPoint.x) * scale;
    const dy = (touch.clientY - this.lastTouchPoint.y) * scale;
    this.viewBox.x -= dx;
    this.viewBox.y -= dy;
    this.updateViewBox();
    this.lastTouchPoint = { x: touch.clientX, y: touch.clientY };
  } else if (event.touches.length === 2) {
    const currentDistance = this.getTouchDistance(event.touches);
    if (this.touchStartDistance > 0) {
      const scaleFactor = this.touchStartDistance / currentDistance;
      const newWidth = this.viewBox.w * scaleFactor;
      const newZoom = this.defaultViewBox.w / newWidth;
      if (newZoom <= this.maxZoom && newZoom >= this.minZoom) {
        const centerPoint = this.getSVGPoint((event.touches[0].clientX + event.touches[1].clientX) / 2, (event.touches[0].clientY + event.touches[1].clientY) / 2);
        this.viewBox.x = centerPoint.x - (centerPoint.x - this.viewBox.x) * scaleFactor;
        this.viewBox.y = centerPoint.y - (centerPoint.y - this.viewBox.y) * scaleFactor;
        this.viewBox.w = newWidth;
        this.viewBox.h = this.viewBox.h * scaleFactor;
        this.updateViewBox();
      }
      this.touchStartDistance = currentDistance;
    }
  }
}

  private onTouchEnd(event: TouchEvent): void {
    if (event.touches.length < 2) this.isPanning = false;
    this.touchStartDistance = 0;
  }

  private handleDoubleTap(clientX: number, clientY: number): void {
    const zoomFactor = 1.5;
    const newWidth = this.viewBox.w / zoomFactor;
    if (this.defaultViewBox.w / newWidth <= this.maxZoom) {
      const point = this.getSVGPoint(clientX, clientY);
      this.animateViewBox(point.x - newWidth / 2, point.y - (this.viewBox.h / zoomFactor) / 2, newWidth, this.viewBox.h / zoomFactor);
    }
  }

  private getTouchDistance(touches: TouchList): number {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  }

  private getSVGPoint(clientX: number, clientY: number): { x: number; y: number } {
    if (!this.svgElement) return { x: 0, y: 0 };
    const pt = this.svgElement.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this.svgElement.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inverseCTM = ctm.inverse();
    const transformedPoint = pt.matrixTransform(inverseCTM);
    return { x: transformedPoint.x, y: transformedPoint.y };
  }

  private updateViewBox(): void {
    if (!this.svgElement) return;

    const viewBoxString = `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.w} ${this.viewBox.h}`;
    this.renderer.setAttribute(this.svgElement, 'viewBox', viewBoxString);

    const newCenterX = Math.round(this.viewBox.x + this.viewBox.w / 2);
    const newCenterY = Math.round(this.viewBox.y + this.viewBox.h / 2);

    this.debugCenterX.set(newCenterX);
    this.debugCenterY.set(newCenterY);
  }

  private playHoverAnimation(target: Element, isHovering: boolean): void {
    if (!(target instanceof SVGTextElement)) return;
    if (isHovering) {
      if (this.currentHighlightedText && this.currentHighlightedText !== target) {
        this.renderer.removeClass(this.currentHighlightedText, 'station-highlight');
      }
      this.renderer.addClass(target, 'station-highlight');
      this.currentHighlightedText = target;
      // 크기나 위치 변경 없음
    } else {
      if (target === this.currentHighlightedText) {
        this.renderer.removeClass(target, 'station-highlight');
        this.currentHighlightedText = null;
      }
    }
  }

  private handleStationClick(stationName: string): void {
    const dbEntry = this.stationDatabase.find(station => station.id === stationName);
    this.selectedStation.set(dbEntry || { id: stationName });
  }

  openImageViewer(): void {
    if (this.imageExists()) this.isImageViewerVisible.set(true);
  }

  closeModal(): void {
    this.selectedStation.set(null);
    this.stationImages.set([]);
    this.currentStationImage.set(null);
    this.currentImageIndex.set(0);
  }

  closeImageViewer(): void {
    this.isImageViewerVisible.set(false);
  }

  resetZoom(): void {
    this.animateViewBox(this.defaultViewBox.x, this.defaultViewBox.y, this.defaultViewBox.w, this.defaultViewBox.h);
  }

  zoomIn(): void {
    const zoomFactor = 1.5;
    const newWidth = this.viewBox.w / zoomFactor;
    if (this.defaultViewBox.w / newWidth <= this.maxZoom) {
      const centerX = this.viewBox.x + this.viewBox.w / 2;
      const centerY = this.viewBox.y + this.viewBox.h / 2;
      this.animateViewBox(centerX - newWidth / 2, centerY - (this.viewBox.h / zoomFactor) / 2, newWidth, this.viewBox.h / zoomFactor);
    }
  }

  zoomOut(): void {
    const zoomFactor = 1.5;
    const newWidth = this.viewBox.w * zoomFactor;
    if (this.defaultViewBox.w / newWidth >= this.minZoom) {
      const centerX = this.viewBox.x + this.viewBox.w / 2;
      const centerY = this.viewBox.y + this.viewBox.h / 2;
      this.animateViewBox(centerX - newWidth / 2, centerY - (this.viewBox.h * zoomFactor) / 2, newWidth, this.viewBox.h * zoomFactor);
    }
  }

  // 검색 결과 정보 getter 개선
  get searchResultInfo(): string {
    const total = this.searchedStations().length;
    if (total === 0 && this.searchQuery()) return '0개';
    if (total === 0) return '';
    const current = this.currentSearchIndex() + 1;
    return `${current} / ${total}개`;
  }

  get currentZoomLevel(): number {
    if (!this.svgElement || this.viewBox.w === 0) return 1;
    return this.defaultViewBox.w / this.viewBox.w;
  }

  get canZoomIn(): boolean { return this.currentZoomLevel < this.maxZoom; }
  get canZoomOut(): boolean { return this.currentZoomLevel > this.minZoom; }

  getLineColor(lineNumber: string): string {
    const lineColors: { [key: string]: string } = {
      '1': '#0052A4', '2': '#00A84D', '3': '#EF7C1C', '4': '#00A5DE', '5': '#996CAC', '6': '#CD7C2F', '7': '#747F00', '8': '#E6186C', '9': '#BDB092',
      '경의중앙': '#77C4A3', '공항철도': '#0090D2', '경춘': '#0C8E72', '수인분당': '#F5A200', '신분당': '#D4003B', '경강': '#003DA5', '서해': '#8FC31F',
      '인천1': '#7CA8D5', '인천2': '#F5A251', '의정부': '#FDA600', '용인': '#56AB2D', '우이신설': '#B7C452', '김포골드': '#A17E46', '신림': '#6789CA'
    };
    return lineColors[lineNumber] || '#999999';
  }
}
