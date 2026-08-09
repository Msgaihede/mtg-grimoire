import type { Preview } from "@storybook/react-vite";
import "../src/index.css";
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
  },
};

export default preview;
