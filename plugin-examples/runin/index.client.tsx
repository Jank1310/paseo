import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RuninScreen } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("machines", RuninScreen);
  client.addSidebarItem({ id: "machines", title: "Runin", icon: "Server", surface: "machines" });
  client.addCommandCenterItem({
    id: "new-machine",
    title: "New runin Machine",
    icon: "Plus",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("machines");
    },
  });
  return () => {};
}
