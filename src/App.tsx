import "./index.css";
import { create } from "zustand"
import { Toaster } from "@/components/ui/sonner"
import { Player } from "./player"

// 创建一个store来管理设置对话框状态
interface SettingsState {
  isSettingsOpen: boolean
  initialPage: string
  setSettingsOpen: (open: boolean) => void
  setInitialPage: (page: string) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  isSettingsOpen: false,
  initialPage: "general",
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setInitialPage: (page) => set({ initialPage: page }),
}))

export default function Page() {
  return (
    // <SidebarProvider>
      // <AppSidebar />
      <>
      <Player />
      <Toaster />
      </>
      // <SettingsDialog />
    // </SidebarProvider>
  )
}
