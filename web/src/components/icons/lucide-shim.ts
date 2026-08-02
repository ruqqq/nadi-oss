/**
 * Phosphor stand-ins for the lucide icon names used by generated shadcn /
 * AI Elements components. This lets us keep Phosphor as the project's only icon
 * library without editing every generated call site: the generated files import
 * lucide names, this module supplies them from Phosphor. (Build step repoints
 * their `from "@/components/icons/lucide-shim"` to this file; lucide-react is then removed.)
 */
export {
  ArrowDown as ArrowDownIcon,
  Brain as BrainIcon,
  CheckCircle as CheckCircleIcon,
  Check as CheckIcon,
  CaretDown as ChevronDownIcon,
  CaretLeft as ChevronLeftIcon,
  CaretRight as ChevronRightIcon,
  CaretUp as ChevronUpIcon,
  Circle as CircleIcon,
  Clock as ClockIcon,
  Copy as CopyIcon,
  ArrowElbowDownLeft as CornerDownLeftIcon,
  Image as ImageIcon,
  CircleNotch as Loader2Icon,
  Microphone as MicIcon,
  Paperclip as PaperclipIcon,
  Plus as PlusIcon,
  MagnifyingGlass as SearchIcon,
  Square as SquareIcon,
  Wrench as WrenchIcon,
  XCircle as XCircleIcon,
  X as XIcon,
  CheckCircle as CircleCheckIcon,
  Info as InfoIcon,
  WarningOctagon as OctagonXIcon,
  Warning as TriangleAlertIcon,
} from "@phosphor-icons/react";
