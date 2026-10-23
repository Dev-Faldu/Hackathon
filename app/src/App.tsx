import { AnimatePresence, motion } from "framer-motion";
import { Sidebar } from "./components/Shell";
import { Toasts } from "./components/ui";
import { useApp } from "./lib/store";
import AfterAction from "./screens/AfterAction";
import EventSetup from "./screens/EventSetup";
import LiveOps from "./screens/LiveOps";
import PlanBoard from "./screens/PlanBoard";
import WhatIf from "./screens/WhatIf";

const SCREENS = { setup: EventSetup, plan: PlanBoard, live: LiveOps, whatif: WhatIf, after: AfterAction };

export default function App() {
  const { screen } = useApp();
  const Current = SCREENS[screen];
  return (
    <div className="aurora relative flex min-h-full">
      <Sidebar />
      <main className="relative z-10 min-w-0 flex-1 px-6 pb-10 pt-6">
        <AnimatePresence mode="wait">
          <motion.div key={screen} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: "easeOut" }}>
            <Current />
          </motion.div>
        </AnimatePresence>
      </main>
      <Toasts />
    </div>
  );
}
