/**
 * Icon vocabulary for the SPA. We use Phosphor Icons (https://phosphoricons.com).
 *
 * Import every icon from this file rather than from "@phosphor-icons/react"
 * directly, so the set of icons the app actually uses stays visible in one
 * place. The shared weight + size are set once in main.tsx via IconContext
 * ("bold" — to echo the monospace, operator-terminal type), so individual call
 * sites stay free of styling unless they need to override it.
 */
export {
  ChatCircle,
  Trash,
  Check,
  X,
  Cpu,
  Gear,
  SignOut,
  Plus,
  ArrowLeft,
  ArrowSquareOut,
  Browser,
  ArrowBendDownRight,
  Key,
  List,
  MagnifyingGlass,
  CaretRight,
  CaretLeft,
  CaretDown,
  CircleNotch,
  Eye,
  EyeSlash,
  Wrench,
  CheckCircle,
  XCircle,
  Clock,
  Archive,
  ArrowCounterClockwise,
  Bell,
  BellRinging,
  File,
  FilePdf,
  FileCode,
  FileSvg,
  FileText,
  DownloadSimple,
  Globe,
  DotsThree,
  DotsThreeVertical,
  FolderSimple,
  Info,
  Copy,
  GitBranch,
  ArrowsClockwise,
  Play,
  CalendarBlank,
  Robot,
  UserPlus,
  Microphone,
  Stop,
  WifiSlash,
  GithubLogo,
  PlugsConnected,
  Warning,
  WarningCircle,
  Stack,
  MapTrifold,
  Sun,
  Notebook,
  Toolbox,
  DeviceMobile,
} from "@phosphor-icons/react";

/**
 * Thinking-effort gauge — a needle on a 240° arc, with the travelled portion lit.
 *
 * Custom rather than Phosphor because this has to be read WITHOUT a text label
 * at ~17px in the composer footer, so the four states must form one ordered
 * ramp. Phosphor has no such family; borrowing unrelated glyphs (a feather, a
 * brain, a flame) gives no inherent ordering, and its signal-bar family reads as
 * network strength in a footer that also shows connection status.
 *
 * `off` parks the needle at the stop with the arc unlit — visibly "at rest"
 * rather than merely empty, which is the state a viewer has to infer in every
 * other shape considered.
 *
 * Lives here so the "all icons in one place" rule still holds.
 */
export function EffortGauge({
  level,
  className,
  ...props
}: {
  level: "off" | "low" | "medium" | "high";
  className?: string;
} & Omit<React.SVGProps<SVGSVGElement>, "level">) {
  // Endpoints precomputed on a 240° sweep (210° → -30°) at r=8 about (12,13).
  const lit = {
    off: null,
    low: { d: "6.86 6.87", largeArc: 0 },
    medium: { d: "17.14 6.87", largeArc: 0 },
    high: { d: "18.93 17", largeArc: 1 },
  }[level];
  const needle = {
    off: "7.67 15.5",
    low: "8.79 9.17",
    medium: "15.21 9.17",
    high: "16.33 15.5",
  }[level];

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M5.07 17 A8 8 0 1 1 18.93 17" strokeOpacity="0.28" />
      {lit && <path d={`M5.07 17 A8 8 0 ${lit.largeArc} 1 ${lit.d}`} />}
      <path d={`M12 13 L${needle}`} />
      <circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
