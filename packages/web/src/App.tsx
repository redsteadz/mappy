import { useRoute } from "./api.ts";
import { Doctor } from "./pages/Doctor.tsx";
import { Home } from "./pages/Home.tsx";
import { NewCrawl } from "./pages/NewCrawl.tsx";
import { ProjectPage } from "./pages/Project.tsx";

function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M8 22V10l8 7 8-7v12" stroke="white" strokeWidth="3" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

export function App() {
  const route = useRoute();
  const [section = "", ...rest] = route;
  const nav = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? "active" : ""}>
      {label}
    </a>
  );
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <Logo /> Mappy
        </a>
        <nav>
          {nav("#/", "Crawls", section === "" || section === "p")}
          {nav("#/new", "New crawl", section === "new")}
          {nav("#/doctor", "Device setup", section === "doctor")}
        </nav>
        <div className="spacer" />
        <span className="muted small">Android UI/UX mapper</span>
      </header>
      {section === "p" && rest[0] ? (
        <ProjectPage id={rest[0]} tab={rest[1] ?? "live"} screen={rest[2]} />
      ) : section === "new" ? (
        <NewCrawl />
      ) : section === "doctor" ? (
        <Doctor />
      ) : (
        <Home />
      )}
    </div>
  );
}
