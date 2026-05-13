import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppHeader } from "@/components/AppHeader";
import Footer from "@/components/Footer";
import { ProductBanner } from "@/components/ProductBanner";
import AppsPage from "@/pages/AppsPage";
import AppDetailPage from "@/pages/AppDetailPage";
import CategoryPage from "@/pages/CategoryPage";
import DownloadPage from "@/pages/DownloadPage";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/apps" />
      </Route>
      <Route path="/apps" component={AppsPage} />
      <Route path="/apps/category/:category" component={CategoryPage} />
      <Route path="/apps/:id" component={AppDetailPage} />
      <Route path="/download" component={DownloadPage} />
      <Route path="/memories">
        <Redirect to="/apps" />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppHeader />
        <Router />
        <Footer />
        <ProductBanner variant="floating" />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
