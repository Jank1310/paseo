import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DeleteButton } from "./delete-button";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  createInput,
  createMachine,
  listJobs,
  listMachineStates,
  removeMachine,
  retrySetup,
  type CreateInput,
  type Job,
} from "../shared/contracts";

export interface RuninClient {
  ui: Pick<
    typeof import("@getpaseo/plugin/client/ui"),
    | "SettingsGroup"
    | "SettingsSection"
    | "SettingsCard"
    | "SettingsRow"
    | "SettingsInput"
    | "SettingsSelect"
    | "SettingsAction"
  >;
}

const sizes = [
  { value: "small", label: "Small · 2 CPU · 4 GiB" },
  { value: "medium", label: "Medium · 4 CPU · 8 GiB" },
  { value: "large", label: "Large · 8 CPU · 16 GiB" },
] as const;
const phaseLabels: Record<Job["phase"], string> = {
  template: "Preparing Paseo Template",
  creating: "Creating Machine",
  starting: "Starting Machine",
  installing: "Installing Paseo",
  ready: "Daemon ready",
  failed: "Setup failed",
};
const jobsKey = (hostId: string) => ["runin-jobs", hostId] as const;
const statesKey = (hostId: string) => ["runin-machine-states", hostId] as const;
const sizeSummaries: Record<CreateInput["size"], string> = {
  small: "Small · 2 CPU · 4 GiB RAM · 30 GiB disk",
  medium: "Medium · 4 CPU · 8 GiB RAM · 30 GiB disk",
  large: "Large · 8 CPU · 16 GiB RAM · 30 GiB disk",
};
interface Status {
  label: string;
  tone: "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted";
}
const unknownStatus: Status = { label: "Unknown", tone: "foregroundMuted" };
const vmStatuses: Record<string, Status> = {
  running: { label: "Running", tone: "statusSuccess" },
  starting: { label: "Starting", tone: "statusWarning" },
  provisioning: { label: "Provisioning", tone: "statusWarning" },
  creating: { label: "Creating", tone: "statusWarning" },
  pending: { label: "Pending", tone: "statusWarning" },
  stopping: { label: "Stopping", tone: "statusWarning" },
  paused: { label: "Paused", tone: "foregroundMuted" },
  stopped: { label: "Stopped", tone: "foregroundMuted" },
  failed: { label: "Failed", tone: "statusDanger" },
  error: { label: "Failed", tone: "statusDanger" },
};

function machineStatus(job: Job, vmPhase: string | undefined): Status {
  if (job.removalRequested) {
    return {
      label: job.error ? "Removal failed" : "Removal pending",
      tone: job.error ? "statusDanger" : "foregroundMuted",
    };
  }
  if (job.phase !== "ready") {
    return {
      label: phaseLabels[job.phase],
      tone: job.phase === "failed" ? "statusDanger" : "statusWarning",
    };
  }
  return Object.hasOwn(vmStatuses, vmPhase ?? "") ? vmStatuses[vmPhase ?? ""] : unknownStatus;
}

function useMachineStates(hostId: string, jobs: Job[] | undefined): Map<string, string> {
  const fetchStates = useRpc(listMachineStates);
  const loadStates = useCallback(() => fetchStates({}), [fetchStates]);
  const stateKey = useMemo(() => statesKey(hostId), [hostId]);
  const machineStates = useQuery({
    queryKey: stateKey,
    queryFn: loadStates,
    enabled: Boolean(jobs?.some((job) => job.machineId)),
    refetchInterval: 30000,
    staleTime: 30000,
    retry: false,
  });
  // A suspended pane must lose its green signal even if the next status
  // request stalls. Query errors also invalidate the cached provider state.
  const [, expireStatus] = useState(0);
  const checkedAt = machineStates.data?.checkedAt;
  useEffect(() => {
    if (checkedAt == null) return;
    const timer = setTimeout(
      () => expireStatus((value) => value + 1),
      Math.max(0, checkedAt + 60001 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [checkedAt]);
  const statesFresh =
    !machineStates.isError && checkedAt != null && Date.now() - checkedAt <= 60000;
  return new Map(
    statesFresh ? machineStates.data?.states.map((state) => [state.machineId, state.phase]) : [],
  );
}

function rememberJob(client: QueryClient, hostId: string, job: Job) {
  client.setQueryData<Job[]>(jobsKey(hostId), (current = []) => {
    const existing = current.some((candidate) => candidate.requestId === job.requestId);
    return existing
      ? current.map((candidate) => (candidate.requestId === job.requestId ? job : candidate))
      : [...current, job];
  });
}

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isSettingUp(job: Job): boolean {
  return job.phase !== "ready" && job.phase !== "failed";
}

// The loader supplies the app's settings controls, so browser coverage can use
// those same controls without importing declaration-only SDK UI exports.
export function createRuninScreen({ ui }: RuninClient) {
  const {
    SettingsGroup,
    SettingsSection,
    SettingsCard,
    SettingsRow,
    SettingsInput,
    SettingsSelect,
    SettingsAction,
  } = ui;

  function RuninScreen({ theme, host, layout }: PluginSurfaceProps) {
    const queryClient = useQueryClient();
    const list = useRpc(listJobs);
    const create = useRpc(createMachine);
    const [name, setName] = useState("My project");
    const [size, setSize] = useState<CreateInput["size"]>("small");
    const [submission, setSubmission] = useState<CreateInput | null>(null);
    const submitted = useRef<CreateInput | null>(null);
    const key = useMemo(() => jobsKey(host.id), [host.id]);
    const load = useCallback(() => list({}), [list]);
    const jobs = useQuery({ queryKey: key, queryFn: load, refetchInterval: 2000 });
    const machineStates = useMachineStates(host.id, jobs.data);
    const creation = useMutation({
      mutationFn: (input: CreateInput) => create(input),
      onSuccess: (job) => {
        rememberJob(queryClient, host.id, job);
        submitted.current = null;
        setSubmission(null);
        void queryClient.invalidateQueries({ queryKey: key });
      },
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: key });
      },
    });
    const resetCreation = creation.reset;
    useEffect(() => {
      if (
        creation.isError &&
        submission &&
        jobs.data?.some((job) => job.requestId === submission.requestId)
      ) {
        submitted.current = null;
        setSubmission(null);
        resetCreation();
      }
    }, [creation.isError, submission, jobs.data, resetCreation]);
    const busy = creation.isPending || Boolean(jobs.data?.some(isSettingUp));
    const canCreate = jobs.isSuccess && !busy && createInput.shape.name.safeParse(name).success;
    const mutate = creation.mutate;
    const submit = useCallback(() => {
      if (!canCreate) return;
      // A lost RPC response does not mean the daemon rejected creation. Keep the
      // exact payload until a response or the persisted job confirms acceptance.
      const input =
        submitted.current ?? createInput.parse({ requestId: newRequestId(), name, size });
      submitted.current = input;
      setSubmission(input);
      mutate(input);
    }, [canCreate, name, size, mutate]);
    const refetch = jobs.refetch;
    const reload = useCallback(() => {
      void refetch();
    }, [refetch]);
    const styles = useMemo(
      () => ({
        list: { gap: 12 },
        root: {
          padding: layout.compact ? 16 : 24,
          backgroundColor: theme.colors.surface0,
          maxWidth: 800,
          width: "100%" as const,
          alignSelf: "center" as const,
        },
        muted: { color: theme.colors.foregroundMuted },
      }),
      [layout.compact, theme],
    );
    const error = creation.error?.message;
    let actionLabel = submission ? "Retry request" : "New Machine";
    if (busy) actionLabel = "Setting up Machine...";

    return (
      <ScrollView contentContainerStyle={styles.root}>
        <SettingsGroup title="Runin Machines" info="Create and manage Runin virtual machines.">
          <SettingsSection title="Machines">
            <View style={styles.list}>
              {jobs.isPending ? <Text style={styles.muted}>Loading Machines...</Text> : null}
              {jobs.error ? (
                <SettingsCard>
                  <SettingsAction
                    label="Machines unavailable"
                    error={jobs.error.message}
                    actionLabel="Retry loading Machines"
                    onPress={reload}
                  />
                </SettingsCard>
              ) : null}
              {jobs.isSuccess && jobs.data.length === 0 ? (
                <Text style={styles.muted}>No Machines yet</Text>
              ) : null}
              {jobs.data?.map((job) => (
                <Machine
                  key={job.requestId}
                  job={job}
                  hostId={host.id}
                  theme={theme}
                  vmPhase={machineStates.get(job.machineId ?? "")}
                />
              ))}
            </View>
          </SettingsSection>
          <SettingsSection title="New Machine">
            <SettingsCard>
              <SettingsInput
                label="Machine name"
                initialValue="My project"
                onChangeText={setName}
                disabled={busy || Boolean(submission)}
                placeholder="My project"
                hint="Use letters, numbers, spaces, or hyphens, up to 40 characters"
              />
              <SettingsSelect<CreateInput["size"]>
                label="Size"
                value={size}
                options={sizes}
                onValueChange={setSize}
                disabled={busy || Boolean(submission)}
              />
              <SettingsAction
                label="Create Machine"
                actionLabel={actionLabel}
                onPress={submit}
                disabled={!canCreate}
                error={error}
                hint={
                  error && submission
                    ? "Request status is unknown. Retry sends the same request to avoid creating a second Machine."
                    : "30 GiB disk and automatic backups"
                }
              />
            </SettingsCard>
          </SettingsSection>
        </SettingsGroup>
      </ScrollView>
    );
  }

  function Machine({
    job,
    hostId,
    theme,
    vmPhase,
  }: {
    job: Job;
    hostId: string;
    theme: PluginSurfaceProps["theme"];
    vmPhase: string | undefined;
  }) {
    const queryClient = useQueryClient();
    const retry = useRpc(retrySetup);
    const remove = useRpc(removeMachine);
    const removal = useMutation({
      mutationFn: () => remove({ requestId: job.requestId }),
      onSuccess: async ({ requestId }) => {
        const key = jobsKey(hostId);
        // Cancel a list captured before deletion before updating the cache.
        await queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Job[]>(key, (current = []) =>
          current.filter((candidate) => candidate.requestId !== requestId),
        );
        await queryClient.invalidateQueries({ queryKey: key });
      },
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: jobsKey(hostId) });
      },
    });
    const setup = useMutation({
      mutationFn: () => retry({ requestId: job.requestId }),
      onSuccess: (updated) => {
        rememberJob(queryClient, hostId, updated);
        void queryClient.invalidateQueries({ queryKey: jobsKey(hostId) });
      },
    });
    const retryMutation = setup.mutate;
    const retryInstallation = useCallback(() => {
      retryMutation();
    }, [retryMutation]);
    const setupActive = setup.isPending || isSettingUp(job);
    const removalDisabled = setupActive || removal.isPending;
    const removeMutation = removal.mutate;
    const confirmRemoval = useCallback(() => {
      if (!removalDisabled) removeMutation();
    }, [removalDisabled, removeMutation]);
    let status = machineStatus(job, vmPhase);
    if (setup.isPending) status = { label: "Retrying setup...", tone: "statusWarning" };
    if (removal.isError) status = { label: "Removal failed", tone: "statusDanger" };
    if (removal.isPending) status = { label: "Removing...", tone: "foregroundMuted" };
    const styles = useMemo(
      () => ({
        status: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
        dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors[status.tone] },
        statusText: { color: theme.colors[status.tone] },
        address: { color: theme.colors.foreground, fontWeight: "500" as const, flexShrink: 1 },
      }),
      [theme, status.tone],
    );
    const error = removal.error?.message ?? setup.error?.message ?? job.error;

    return (
      <SettingsCard testID={`runin-machine-${job.requestId}`}>
        <SettingsRow label={job.name} hint={sizeSummaries[job.size]} error={error}>
          <View style={styles.status}>
            <View
              style={styles.dot}
              testID={`runin-status-dot-${job.requestId}`}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text style={styles.statusText} accessibilityLiveRegion="polite">
              {status.label}
            </Text>
          </View>
        </SettingsRow>
        {job.phase === "template" ? (
          <SettingsRow
            label="Template setup"
            hint="The first Template build may take several minutes"
          />
        ) : null}
        {job.machineId ? (
          <SettingsRow label="SSH address">
            <Text selectable style={styles.address}>{`ssh://${job.machineId}@runin.eu`}</Text>
          </SettingsRow>
        ) : null}
        {job.phase === "ready" && job.machineId && !job.removalRequested && !removal.isPending ? (
          <SettingsRow
            label="Connect in Paseo"
            hint="In Paseo desktop, open the host picker, choose Add host, then Remote SSH. Paste this URI into SSH host and click Connect."
          />
        ) : null}
        {job.phase === "failed" && !job.removalRequested ? (
          <SettingsAction
            label="Resume Machine setup"
            actionLabel={setup.isPending ? "Retrying setup..." : "Retry setup"}
            onPress={retryInstallation}
            disabled={setup.isPending || removal.isPending}
            hint="Reuses this Machine and resumes preparation"
          />
        ) : null}
        <RemovalActions
          job={job}
          theme={theme}
          pending={removal.isPending}
          failed={removal.isError}
          setupActive={setupActive}
          onConfirm={confirmRemoval}
        />
      </SettingsCard>
    );
  }

  function RemovalActions({
    job,
    theme,
    pending,
    failed,
    setupActive,
    onConfirm,
  }: {
    job: Job;
    theme: PluginSurfaceProps["theme"];
    pending: boolean;
    failed: boolean;
    setupActive: boolean;
    onConfirm(): void;
  }) {
    const [confirming, setConfirming] = useState(false);
    const begin = useCallback(() => setConfirming(true), []);
    const cancel = useCallback(() => setConfirming(false), []);
    const disabled = setupActive || pending;
    if (!confirming) {
      return (
        <SettingsAction
          label="Remove Machine"
          actionLabel="Remove"
          onPress={begin}
          disabled={disabled}
          hint={setupActive ? "Wait for Machine setup to finish before removing it" : undefined}
        />
      );
    }
    return (
      <>
        <SettingsRow
          label="Delete Machine?"
          hint={`Permanently delete ${job.name}${job.machineId ? ` (${job.machineId})` : ""} and all its data. This cannot be undone.`}
        >
          <DeleteButton theme={theme} pending={pending} onPress={onConfirm} disabled={disabled} />
        </SettingsRow>
        <SettingsAction
          label="Removal confirmation"
          actionLabel={job.removalRequested || failed ? "Close" : "Cancel"}
          onPress={cancel}
          disabled={pending}
        />
      </>
    );
  }

  return RuninScreen;
}
