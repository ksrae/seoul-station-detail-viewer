import { Routes } from '@angular/router';
import { MapComponent } from './map/map.component'; // MapComponent 임포트

export const routes: Routes = [
  {
    path: '', // 기본 경로 (예: http://localhost:4200/)
    component: MapComponent // 이 경로로 접속 시 MapComponent를 렌더링
  },
  // 다른 라우트가 필요하다면 여기에 추가할 수 있습니다.
  // { path: 'about', component: AboutComponent },
  {
    path: '**', // 일치하는 라우트가 없을 경우 (페이지 없음)
    redirectTo: '', // 기본 경로로 리디렉션
    pathMatch: 'full'
  }
];
