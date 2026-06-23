import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
// Install globals needed by @testing-library/react
g.document = window.document;
g.window = window;
g.navigator = window.navigator;
g.HTMLElement = window.HTMLElement;
g.Element = window.Element;
g.Node = window.Node;
g.Event = window.Event;
g.CustomEvent = window.CustomEvent;
g.MutationObserver = window.MutationObserver;
