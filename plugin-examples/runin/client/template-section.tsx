import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { getTemplateStatus, updateTemplate, type TemplateStatus } from "../shared/contracts";
import type { RuninClient } from "./screen";

const labels: Record<TemplateStatus["state"], string> = {
  missing: "Template not built",
  outdated: "Template update available",
  building: "Building template",
  preparing: "Preparing template",
  ready: "Template up to date",
  failed: "Template preparation failed",
};

export function TemplateSection({ ui, hostId }: RuninClient & { hostId: string }) {
  const { SettingsSection, SettingsCard, SettingsRow, SettingsAction } = ui;
  const client = useQueryClient();
  const check = useRpc(getTemplateStatus);
  const update = useRpc(updateTemplate);
  const key = ["runin-template", hostId] as const;
  const load = useCallback(() => check({}), [check]);
  const status = useQuery({
    queryKey: key,
    queryFn: load,
    refetchInterval: 10_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () => update({}),
    onSuccess: () => {
      client.setQueryData<TemplateStatus>(key, (current) =>
        current ? { ...current, updating: true, error: null } : current,
      );
      void client.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const mutate = mutation.mutate;
  const start = useCallback(() => mutate(), [mutate]);
  const refetch = status.refetch;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  let content = <SettingsRow label="Checking template version..." />;
  if (status.isError) {
    content = (
      <SettingsAction
        label="Template status unavailable"
        error={status.error.message}
        actionLabel="Check again"
        onPress={reload}
        disabled={status.isFetching}
      />
    );
  } else if (status.data) {
    content = (
      <TemplateDetails
        ui={ui}
        current={status.data}
        busy={mutation.isPending || status.data.updating}
        error={mutation.error?.message ?? status.data.error}
        rechecking={status.isFetching}
        onUpdate={start}
        onCheck={reload}
      />
    );
  }
  return (
    <SettingsSection
      title="Machine template"
      info="Updates apply to future Machines. Existing Machines keep their installed software."
    >
      <SettingsCard>{content}</SettingsCard>
    </SettingsSection>
  );
}

function TemplateDetails({
  ui,
  current,
  busy,
  error,
  rechecking,
  onUpdate,
  onCheck,
}: RuninClient & {
  current: TemplateStatus;
  busy: boolean;
  error: string | null;
  rechecking: boolean;
  onUpdate(): void;
  onCheck(): void;
}) {
  const { SettingsRow, SettingsAction } = ui;
  let actionLabel = current.state === "missing" ? "Build template" : "Update template";
  if (current.state === "building" || current.state === "preparing")
    actionLabel = "Continue update";
  if (error) actionLabel = "Retry update";
  if (busy) actionLabel = "Updating template...";
  let action = (
    <SettingsAction
      label={busy ? "Updating template" : labels[current.state]}
      actionLabel={actionLabel}
      onPress={onUpdate}
      disabled={busy}
      error={error}
      hint="Building and preparing all Machine sizes may take several minutes."
    />
  );
  if (current.state === "ready" && !busy) {
    action = <SettingsRow label={labels.ready} />;
  } else if (current.state === "failed" && !busy) {
    action = (
      <SettingsAction
        label={labels.failed}
        error={error}
        actionLabel="Check again"
        onPress={onCheck}
        disabled={rechecking}
      />
    );
  }
  return (
    <>
      <SettingsRow label="Available version" hint={current.currentVersion ?? "No template yet"} />
      <SettingsRow label="Required version" hint={current.expectedVersion} />
      {action}
    </>
  );
}
