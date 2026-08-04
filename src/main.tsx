import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Named rather than cast: `index.html` is the only place this element comes from, and a
// missing `#root` should say so instead of failing inside React on a null container.
const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing its #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
