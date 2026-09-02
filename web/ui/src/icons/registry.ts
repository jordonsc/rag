import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  Clock,
  Copy,
  CornerDownRight,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Info,
  Layers,
  Link2,
  List,
  ListFilter,
  OctagonAlert,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every glyph this application can draw, by the name a caller asks for.
 *
 * **An explicit table rather than the whole library.** Icon names arrive as
 * strings — a table column declares one, a nav item declares one — so a
 * component cannot import a glyph directly and a bundler cannot see which of
 * the ~1,600 Lucide exports are reachable. Naming them here is what keeps the
 * bundle to the icons we actually draw: the set is fixed at build time, so
 * there is nothing to resolve at run time and nothing to tree-shake around.
 *
 * The key is ours, not Lucide's. Mostly they agree, but they need not: a name
 * Lucide renames between releases can be pinned here in one line rather than
 * chased through every call site.
 */
export const iconRegistry: Record<string, LucideIcon> = {
  archive: Archive,
  'archive-restore': ArchiveRestore,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  bot: Bot,
  'book-open': BookOpen,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  circle: Circle,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  // Lucide 1.x renamed this from `CircleHelp`; the name callers use is ours.
  'circle-help': CircleQuestionMark,
  'circle-x': CircleX,
  clock: Clock,
  copy: Copy,
  'corner-down-right': CornerDownRight,
  'external-link': ExternalLink,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  'git-branch': GitBranch,
  info: Info,
  layers: Layers,
  link: Link2,
  list: List,
  'list-filter': ListFilter,
  'octagon-alert': OctagonAlert,
  pencil: Pencil,
  plus: Plus,
  refresh: RefreshCw,
  save: Save,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  tag: Tag,
  trash: Trash2,
  'triangle-alert': TriangleAlert,
  user: User,
  x: X,
};

/** The names the registry holds — useful to a picker, and to the tests. */
export const iconNames: readonly string[] = Object.keys(iconRegistry);
