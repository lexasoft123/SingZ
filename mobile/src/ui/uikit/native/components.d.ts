import type { ReactNode } from 'react';
import { type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { type GlassElevation } from './theme.js';
export interface GlassSurfaceProps extends ViewProps {
    readonly radius?: number;
    readonly elevation?: GlassElevation;
    readonly style?: StyleProp<ViewStyle>;
    readonly children?: ReactNode;
}
export declare function GlassSurface({ radius, elevation, style, children, ...props }: GlassSurfaceProps): React.JSX.Element;
export declare function GlassHeader({ title, onBack, backLabel, trailing }: {
    readonly title: string;
    readonly onBack: () => void;
    readonly backLabel?: string;
    readonly trailing?: ReactNode;
}): React.JSX.Element;
export interface ChoiceChipProps {
    readonly label: string;
    readonly selected?: boolean;
    readonly disabled?: boolean;
    readonly onPress: () => void;
    readonly style?: StyleProp<ViewStyle>;
}
export declare function ChoiceChip({ label, selected, disabled, onPress, style }: ChoiceChipProps): React.JSX.Element;
export declare function PrimaryAction({ label, icon, onPress, disabled, style }: {
    readonly label: string;
    readonly icon?: ReactNode;
    readonly onPress: () => void;
    readonly disabled?: boolean;
    readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export declare function RoundAction({ label, icon, onPress, size, backgroundColor, disabled }: {
    readonly label: string;
    readonly icon: ReactNode;
    readonly onPress: () => void;
    readonly size?: number;
    readonly backgroundColor?: string;
    readonly disabled?: boolean;
}): React.JSX.Element;
export declare function SettingsCard({ children, style }: {
    readonly children: ReactNode;
    readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export declare function Hairline(): React.JSX.Element;
export declare function SettingsRow({ label, value, expanded, onPress }: {
    readonly label: string;
    readonly value: string;
    readonly expanded?: boolean;
    readonly onPress: () => void;
}): React.JSX.Element;
export declare function StickyActionFooter({ children, style }: {
    readonly children: ReactNode;
    readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export declare function GlassTabBar({ children, style }: {
    readonly children: ReactNode;
    readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export declare function GlassTab({ label, accessibilityLabel, selected, icon, onPress, onLongPress, testID }: {
    readonly label: string;
    readonly accessibilityLabel?: string;
    readonly selected: boolean;
    readonly icon: ReactNode;
    readonly onPress: () => void;
    readonly onLongPress?: () => void;
    readonly testID?: string;
}): React.JSX.Element;
export declare function FeatureCard({ title, description, glyph, onPress }: {
    readonly title: string;
    readonly description: string;
    readonly glyph: ReactNode;
    readonly onPress: () => void;
}): React.JSX.Element;
export declare function ListEntry({ title, detail, trailing, onPress }: {
    readonly title: string;
    readonly detail: string;
    readonly trailing?: ReactNode;
    readonly onPress: () => void;
}): React.JSX.Element;
export interface ReferenceControlsProps {
    readonly volumePercent: number;
    readonly volumePosition: number;
    readonly volumeMinPercent?: number;
    readonly volumeMaxPercent?: number;
    readonly testLabel: string;
    readonly testing?: boolean;
    readonly testIcon?: ReactNode;
    readonly onTest: () => void;
    readonly onDecrease: () => void;
    readonly onIncrease: () => void;
    readonly decreaseDisabled?: boolean;
    readonly increaseDisabled?: boolean;
    readonly hint?: string;
    readonly pitchWindow?: {
        readonly value: number;
        readonly options: readonly number[];
        readonly onChange: (value: number) => void;
    };
}
export declare function ReferenceControls(props: ReferenceControlsProps): React.JSX.Element;
export interface PitchTargetItem {
    readonly label: string;
    readonly state: 'future' | 'active' | 'done';
}
export declare function PitchTarget({ noteName, eyebrow, sequence, testID, style }: {
    readonly noteName: string;
    readonly eyebrow: string;
    readonly sequence?: readonly PitchTargetItem[];
    readonly testID?: string;
    readonly style?: StyleProp<ViewStyle>;
}): React.JSX.Element;
export declare function Countdown({ value, label, hint }: {
    readonly value: number;
    readonly label?: string;
    readonly hint: string;
}): React.JSX.Element;
export interface PitchMeterProps {
    readonly cents: number | null;
    readonly pitchWindowCents: number;
    readonly detectedNote: string | null;
    readonly progress: number;
    readonly centered: boolean;
    readonly instruction: string;
    readonly reading: string;
    readonly accessibilityReading?: string;
    readonly hint: string;
}
export declare function PitchMeter(props: PitchMeterProps): React.JSX.Element;
export interface TransportItem {
    readonly accessibilityLabel: string;
    readonly caption: string;
    readonly icon: ReactNode;
    readonly onPress?: () => void;
}
export declare function TransportDock({ left, center, right, hint }: {
    readonly left?: TransportItem;
    readonly center: TransportItem;
    readonly right?: TransportItem;
    readonly hint: string;
}): React.JSX.Element;
