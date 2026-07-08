import { Routes } from '@angular/router';

/** Routes per docs/rewrite-plan.md §4. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/setup/setup-page').then((m) => m.SetupPage),
    title: 'Web Access Advisor — New recording',
  },
  {
    path: 'sessions',
    loadComponent: () =>
      import('./features/sessions/sessions-page').then((m) => m.SessionsPage),
    title: 'Web Access Advisor — Sessions',
  },
  {
    path: 'sessions/:id/record',
    loadComponent: () => import('./features/record/record-page').then((m) => m.RecordPage),
    title: 'Web Access Advisor — Recording',
  },
  {
    path: 'sessions/:id/analyze',
    loadComponent: () => import('./features/analyze/analyze-page').then((m) => m.AnalyzePage),
    title: 'Web Access Advisor — Analysis',
  },
  {
    path: 'sessions/:id/results',
    loadComponent: () => import('./features/results/results-page').then((m) => m.ResultsPage),
    title: 'Web Access Advisor — Results',
  },
  { path: '**', redirectTo: '' },
];
