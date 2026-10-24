import { AnimatePresence, motion } from "framer-motion";
import { MobileNav, Sidebar } from "./components/Shell";
import { Toasts } from "./components/ui";
import { useApp } from "./lib/store";
import AfterAction from "./screens/AfterAction";
import EventSetup from "./screens/EventSetup";
import LiveOps from "./screens/LiveOps";
import Parking from "./screens/Parking";
import PlanBoard from "./screens/PlanBoard";
import WhatIf from "./screens/WhatIf";
import La28 from "./screens/La28";
import Bookings from "./screens/Bookings";
import World3D from "./screens/World3D";
import Copilot from "./screens/Copilot";

const SCREENS = { ai: Copilot, setup: EventSetup, bookings: Bookings, parking: Parking, world: World3D, plan: PlanBoard, live: LiveOps, whatif: WhatIf, after: AfterAction, la28: La28 };

export default function App() {
  const { screen } = useApp();
  const Current = SCREENS[screen];
  return (
    <div className="aurora relative flex min-h-full flex-col md:flex-row">
      <MobileNav />
      <Sidebar />
      <main className="relative z-10 min-w-0 flex-1 px-3 pb-10 pt-3 md:px-6 md:pt-6">
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
