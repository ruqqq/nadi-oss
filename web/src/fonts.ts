// Self-hosted Dispatch type system — limited weights for a light mobile payload.
// Family names ("Fraunces" / "Inter" / "JetBrains Mono") match the @theme tokens
// in index.css.
import "@fontsource/fraunces/400.css"; // display
import "@fontsource/fraunces/600.css";
import "@fontsource/inter/400.css"; // body / UI
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css"; // data
import "@fontsource/jetbrains-mono/500.css";

// Arabic (Amiri / Amiri Quran) is deliberately NOT imported here — it is fetched
// on first sight of Arabic text instead. See lib/arabic-font.ts for why.
