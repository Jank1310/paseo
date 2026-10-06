import { useCallback, useMemo } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// Paseo 0.10.2 does not export Button through its plugin SDK. Match its small
// button geometry and interaction states using the available semantic colors.
export function DeleteButton({
  theme,
  pending,
  disabled,
  onPress,
}: {
  theme: PluginSurfaceProps["theme"];
  pending: boolean;
  disabled: boolean;
  onPress(): void;
}) {
  const styles = useMemo(
    () => ({
      button: {
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.statusDanger,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      text: { fontSize: 14, fontWeight: "normal" as const, color: theme.colors.surface0 },
    }),
    [theme],
  );
  const buttonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => {
      let opacity = pressed ? 0.85 : 1;
      if (disabled) opacity = 0.5;
      return [styles.button, { opacity }];
    },
    [styles, disabled],
  );
  const accessibilityState = useMemo(() => ({ disabled, busy: pending }), [disabled, pending]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={buttonStyle}
    >
      <Text style={styles.text}>{pending ? "Removing..." : "Delete Machine"}</Text>
    </Pressable>
  );
}
