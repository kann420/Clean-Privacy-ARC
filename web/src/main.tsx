import { createRoot } from "react-dom/client";
import App from "./App";
import { WalletProviders } from "./wallet/WalletProviders";
import "./styles/fonts.css";
import "./styles/theme.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

// No StrictMode: the mascot spritesheet and the counter scramble are timer-driven, and
// double-invoked development effects made both stutter. Every hook still cleans up.
createRoot(container).render(
  <WalletProviders>
    <App />
  </WalletProviders>,
);
