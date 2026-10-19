import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_THEME_COLOR,
  DARK_APPEARANCE_MEDIA_QUERY,
} from "./appearance";
import { AppearanceControl } from "./appearance-control";
import { AppearanceProvider } from "./appearance-provider";

interface MatchMediaController {
  setDark: (matches: boolean) => void;
}

function installMatchMedia(initiallyDark: boolean): MatchMediaController {
  let matches = initiallyDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: DARK_APPEARANCE_MEDIA_QUERY,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  } as MediaQueryList;

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      expect(query).toBe(DARK_APPEARANCE_MEDIA_QUERY);
      return mediaQuery;
    }),
  );

  return {
    setDark(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: DARK_APPEARANCE_MEDIA_QUERY } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function renderControl(): void {
  render(
    <AppearanceProvider>
      <AppearanceControl />
    </AppearanceProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-appearance");
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppearanceControl", () => {
  it("self-provides when a page renders it outside the application provider", async () => {
    installMatchMedia(true);
    render(<AppearanceControl label="독립 화면 모드" />);

    expect(screen.getByRole("group", { name: "독립 화면 모드" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "시스템" })).toBeChecked();
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });

    fireEvent.click(screen.getByRole("radio", { name: "밝게" }));
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("uses the system preference by default and exposes native radio controls", async () => {
    installMatchMedia(false);
    renderControl();

    expect(screen.getByRole("group", { name: "화면 모드" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "시스템" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "밝게" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "어둡게" })).not.toBeChecked();

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-appearance", "system");
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      APPEARANCE_THEME_COLOR.light,
    );
  });

  it("persists a manual mode and returns to the unstored system default", async () => {
    installMatchMedia(false);
    renderControl();

    fireEvent.click(screen.getByRole("radio", { name: "어둡게" }));
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-appearance", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      APPEARANCE_THEME_COLOR.dark,
    );

    fireEvent.click(screen.getByRole("radio", { name: "시스템" }));
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-appearance", "system");
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
  });

  it("reacts to operating-system changes only while system mode is selected", async () => {
    const media = installMatchMedia(false);
    renderControl();

    act(() => media.setDark(true));
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });

    fireEvent.click(screen.getByRole("radio", { name: "밝게" }));
    act(() => media.setDark(false));
    act(() => media.setDark(true));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("uses a valid stored preference during provider initialization", async () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "dark");
    installMatchMedia(false);
    renderControl();

    expect(screen.getByRole("radio", { name: "어둡게" })).toBeChecked();
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
  });
});
