// @rag/ui — the design system the ledger viewer is drawn from.
//
// **Controlled components only: nothing here fetches.** A component takes its
// value and its callback from the surface rendering it and knows no transport,
// no endpoint and no ledger vocabulary. Everything that knows what a topic is
// lives in `@rag/app`.
//
// Tokens ship as CSS: a consumer imports '@rag/ui/src/tokens.css' once, at the
// application root. There is one theme and no provider — see `tokens.css`.

// i18n
export {
  I18nProvider,
  useT,
  enGB,
  type Catalogue,
  type MessageKey,
  type Translate,
  type TranslateParams,
  type I18nProviderProps,
} from './i18n';

// Locale-aware value formatting. Part of the package's surface like everything
// else here: a consumer reaching past the barrel into './src/i18n' would be
// depending on this package's file layout rather than on its API.
export { useLocale, useFormat, type Formatters } from './i18n';
export { formatNumber, formatDuration, formatDurationSeconds, formatStamp } from './i18n';
export { DEFAULT_LOCALE, type DurationLabels } from './i18n';

// Icons
export { Icon, type IconProps } from './components/Icon';
export { iconRegistry, iconNames } from './icons/registry';

// Buttons
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
} from './components/Button';

// Inputs
export {
  Input,
  NumberInput,
  Select,
  Segmented,
  Textarea,
  Toggle,
  SecretInput,
  ChipList,
  Checkbox,
  CheckboxSet,
  DurationInput,
  Picker,
  Slider,
  naturalUnit,
  unitMillis,
  type DurationInputProps,
  type DurationUnit,
  type PickerProps,
  type InputProps,
  type NumberInputProps,
  type SelectProps,
  type SegmentedProps,
  type SelectOption,
  type TextareaProps,
  type ToggleProps,
  type SecretInputProps,
  type ChipListHandle,
  type ChipListProps,
  type CheckboxProps,
  type CheckboxSetProps,
  type SliderProps,
} from './components/inputs';

// Form structure
export {
  Field,
  Fieldset,
  Form,
  type FieldProps,
  type FieldsetProps,
  type FormProps,
} from './components/form';

// Table
export {
  Table,
  groupRuns,
  type TableProps,
  type TableGrouping,
  type TableGroupHeader,
  type Column,
  type TableSort,
  type SortDirection,
} from './components/Table';

// The identity cell — a row's glyph, its name and the quieter line beneath.
// The style is `components/rows.module.css`, which `Table.module.css` composes.
export { RowIdentity, type RowIdentityProps } from './components/rows';

// Surfaces
export {
  Card,
  Disclosure,
  Panel,
  Tabs,
  type CardProps,
  type DisclosureProps,
  type PanelProps,
  type TabsProps,
  type TabItem,
} from './components/surfaces';

// Overlays
export {
  Dialog,
  ConfirmDialog,
  Drawer,
  Tooltip,
  placeTooltip,
  type DialogProps,
  type ConfirmDialogProps,
  type DrawerProps,
  type TooltipProps,
  type TooltipPlacement,
  type TipPosition,
} from './components/overlays';

// Status
export {
  Badge,
  StateDot,
  SeverityIcon,
  isKnownSeverity,
  EmptyState,
  ErrorState,
  type BadgeProps,
  type BadgeTone,
  type Tone,
  type StateDotProps,
  type Severity,
  type SeverityToken,
  type SeverityIconProps,
  type EmptyStateProps,
  type ErrorStateProps,
} from './components/status';

export { Spinner, type SpinnerProps } from './components/Spinner';

// Navigation
export {
  NavRail,
  TopNav,
  type NavRailProps,
  type NavRailItem,
  type TopNavProps,
  type TopNavItem,
} from './components/nav';
