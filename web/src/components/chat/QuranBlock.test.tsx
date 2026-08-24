// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageResponse } from "@/components/ai-elements/message";
import { QuranBlock } from "./QuranBlock";

const AYAH = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ";
const TRANSLATION = "Allah — there is no deity except Him, the Ever-Living, the Sustainer.";

afterEach(cleanup);

describe("QuranBlock", () => {
  it("renders reference, Arabic and translation", () => {
    const { container } = render(
      <QuranBlock source={`2:255 Al-Baqarah\n${AYAH}\n\n${TRANSLATION}`} />,
    );

    expect(screen.getByText("Al-Baqarah · 2:255")).toBeTruthy();
    expect(screen.getByText(TRANSLATION)).toBeTruthy();

    const arabic = container.querySelector('p[lang="ar"]');
    expect(arabic?.getAttribute("dir")).toBe("rtl");
    expect(arabic?.textContent).toContain(AYAH);
  });

  it("closes a single ayah with an Arabic-Indic medallion", () => {
    const { container } = render(<QuranBlock source={`2:255\n${AYAH}`} />);
    const medallion = container.querySelector('[aria-hidden="true"]');
    expect(medallion?.textContent).toBe("٢٥٥");
  });

  it("keeps the medallion out of the Arabic text flow", () => {
    // Inline is where a mushaf puts it, but Arabic final forms paint outside
    // their advance box — the tail of ر in ٱلْقَدْرِ ran straight through an
    // inline medallion while layout reported no collision. Anything that puts
    // it back inside the verse paragraph reintroduces that, so pin it here.
    const { container } = render(<QuranBlock source={"97:1 Al-Qadr\nإِنَّآ أَنزَلْنَـٰهُ فِى لَيْلَةِ ٱلْقَدْرِ"} />);

    expect(container.querySelector('p[lang="ar"] [aria-hidden="true"]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe("١");
  });

  it("omits the medallion for a range, which has no single marker", () => {
    const { container } = render(<QuranBlock source={`2:255-257\n${AYAH}`} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText(/2:255–257/)).toBeTruthy();
  });

  it("shows the bare reference when the fence names no surah", () => {
    render(<QuranBlock source={`2:255\n${AYAH}`} />);
    expect(screen.getByText("2:255")).toBeTruthy();
  });

  it("renders the Arabic even when the reference is unparseable", () => {
    const { container } = render(<QuranBlock source={AYAH} />);
    expect(container.querySelector('p[lang="ar"]')?.textContent).toContain(AYAH);
    expect(container.querySelector("figcaption")).toBeNull();
  });

  it("renders nothing for an empty fence", () => {
    const { container } = render(<QuranBlock source="" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("MessageResponse markdown pipeline", () => {
  it("turns a quran fence into a verse block, not a code block", () => {
    const { container } = render(
      <MessageResponse>{`Here it is:\n\n\`\`\`quran\n2:255 Al-Baqarah\n${AYAH}\n\n${TRANSLATION}\n\`\`\`\n`}</MessageResponse>,
    );

    expect(container.querySelector("figure")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByText("Al-Baqarah · 2:255")).toBeTruthy();
    expect(screen.getByText(TRANSLATION)).toBeTruthy();
  });

  it("renders a verse block while the fence is still streaming in", () => {
    const { container } = render(
      <MessageResponse>{`\`\`\`quran\n2:255\n${AYAH}`}</MessageResponse>,
    );

    expect(container.querySelector("figure")).toBeTruthy();
    expect(container.querySelector('p[lang="ar"]')?.textContent).toContain(AYAH);
  });

  it("flips an Arabic-only paragraph to RTL", () => {
    const { container } = render(<MessageResponse>{AYAH}</MessageResponse>);
    const paragraph = container.querySelector("p");
    expect(paragraph?.getAttribute("dir")).toBe("rtl");
    expect(paragraph?.className).toContain("arabic-block");
  });

  it("marks inline Arabic without flipping its English paragraph", () => {
    const { container } = render(
      <MessageResponse>{"The phrase الحمد لله means all praise is due to God."}</MessageResponse>,
    );

    const paragraph = container.querySelector("p");
    expect(paragraph?.getAttribute("dir")).not.toBe("rtl");

    const span = container.querySelector("span.arabic-inline");
    expect(span?.textContent).toBe("الحمد لله");
    expect(span?.getAttribute("lang")).toBe("ar");
    expect(span?.getAttribute("dir")).toBeNull();
  });

  it("leaves ordinary markdown alone", () => {
    const { container } = render(
      <MessageResponse>{"Just **English** here.\n\n```ts\nconst x = 1;\n```"}</MessageResponse>,
    );

    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("span.arabic-inline")).toBeNull();
    // Streamdown renders emphasis as its own span, not <strong> — asserting on
    // its markers is what proves our `components` override MERGES with
    // streamdown's defaults rather than replacing them.
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("English");
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeTruthy();
  });
});
