import { Route, Switch, useLocation } from 'wouter';
import { Sidebar } from './components/Sidebar';
import { AlertBannerStack } from './components/AlertBannerStack';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useLiveEvents } from './hooks/useLiveEvents';
import { useLiveStore } from './store/liveStore';
import { Today } from './views/Today';
import { Sessions } from './views/Sessions';
import { History } from './views/History';
import { Audit } from './views/Audit';
import { Replay } from './views/Replay';

export function App(): JSX.Element {
  useLiveEvents();
  const connected = useLiveStore((s) => s.connected);
  const [location, navigate] = useLocation();

  return (
    <div className="flex flex-col h-full">
      <AlertBannerStack />
      <div className="flex flex-1 min-h-0">
        <Sidebar currentPath={location} onNavigate={navigate} connected={connected} />
        <main className="flex-1 overflow-auto p-5">
          <ErrorBoundary resetKey={location}>
            <Switch>
              <Route path="/replay/:sessionId" component={Replay} />
              <Route path="/sessions" component={Sessions} />
              <Route path="/history" component={History} />
              <Route path="/audit" component={Audit} />
              <Route path="/" component={Today} />
              <Route>
                <div className="text-ink-muted">Not found</div>
              </Route>
            </Switch>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
