import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";
import "./app.css";
import "./landing.css";
import "./pilot-theme.css";
import "./pilot-terminal.css";
import "./calledit.css";
import "./early.css";
import "./landing-dots.css";
import { App } from "./App";
import { installSlidingIndicators } from "./lib/slide";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

installSlidingIndicators();
