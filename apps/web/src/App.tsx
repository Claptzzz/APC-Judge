import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { LoadingState } from './components/ui';
import type { Role } from './gen/graphql';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProblemsPage } from './pages/ProblemsPage';

/** Carga diferida de una página con export nombrado (CodeMirror y Markdown van en chunks aparte). */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

const ProblemDetailPage = page(() => import('./pages/ProblemDetailPage'), 'ProblemDetailPage');
const SubmissionPage = page(() => import('./pages/SubmissionPage'), 'SubmissionPage');
const MySubmissionsPage = page(() => import('./pages/MySubmissionsPage'), 'MySubmissionsPage');
const ContestsPage = page(() => import('./pages/ContestsPage'), 'ContestsPage');
const ContestDetailPage = page(() => import('./pages/ContestDetailPage'), 'ContestDetailPage');
const AssistantPage = page(() => import('./pages/AssistantPage'), 'AssistantPage');
const ProfilePage = page(() => import('./pages/ProfilePage'), 'ProfilePage');
const CreateProblemPage = page(() => import('./pages/admin/ProblemFormPage'), 'CreateProblemPage');
const EditProblemPage = page(() => import('./pages/admin/ProblemFormPage'), 'EditProblemPage');
const CreateContestPage = page(() => import('./pages/admin/ContestFormPage'), 'CreateContestPage');

const SETTERS: Role[] = ['SETTER', 'ADMIN'];

function Private({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  return <RequireAuth {...(roles ? { roles } : {})}>{children}</RequireAuth>;
}

/** Rutas de la SPA. Requiere un Router, Apollo, AuthProvider y ThemeProvider por encima. */
export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/problems" replace />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="problems" element={<ProblemsPage />} />
          <Route path="problems/:slug" element={<ProblemDetailPage />} />
          <Route
            path="submissions"
            element={
              <Private>
                <MySubmissionsPage />
              </Private>
            }
          />
          <Route
            path="submissions/:id"
            element={
              <Private>
                <SubmissionPage />
              </Private>
            }
          />
          <Route
            path="contests"
            element={
              <Private>
                <ContestsPage />
              </Private>
            }
          />
          <Route
            path="contests/:id"
            element={
              <Private>
                <ContestDetailPage />
              </Private>
            }
          />
          <Route
            path="assistant"
            element={
              <Private>
                <AssistantPage />
              </Private>
            }
          />
          <Route
            path="profile"
            element={
              <Private>
                <ProfilePage />
              </Private>
            }
          />
          <Route
            path="admin/problems/new"
            element={
              <Private roles={SETTERS}>
                <CreateProblemPage />
              </Private>
            }
          />
          <Route
            path="admin/problems/:slug/edit"
            element={
              <Private roles={SETTERS}>
                <EditProblemPage />
              </Private>
            }
          />
          <Route
            path="admin/contests/new"
            element={
              <Private roles={SETTERS}>
                <CreateContestPage />
              </Private>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

/** La key reinicia el ErrorBoundary al navegar a otra ruta. */
export function App() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <AppRoutes />
    </ErrorBoundary>
  );
}
