import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
// Install globals needed by @testing-library/react
(globalThis as any).document = window.document;
(globalThis as any).window = window;
(globalThis as any).navigator = window.navigator;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Element = window.Element;
(globalThis as any).Node = window.Node;
(globalThis as any).Event = window.Event;
(globalThis as any).CustomEvent = window.CustomEvent;
(globalThis as any).MutationObserver = window.MutationObserver;
