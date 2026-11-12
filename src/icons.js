// Line icons from Lucide (ISC license), rendered as inline SVG strings so they inherit text color.
import {
  House, CalendarDays, Wallet, Images, HardHat, FolderOpen, Plus, Download, Pencil, ShoppingCart, Paperclip,
  FileText, SlidersHorizontal, Hammer, CalendarClock, TriangleAlert, NotebookPen, ShieldCheck, Users, Receipt,
  Landmark, Truck, ClipboardList, CircleHelp, Lightbulb, ShowerHead, Refrigerator, LayoutGrid, PanelsTopLeft,
  Wrench, PaintRoller, DoorOpen, Trees, Package, Layers, Square, ChartColumn, ListChecks, ArrowLeftRight,
  Building2, UserPlus, LogOut, Upload, ChartLine, Clock,
} from "lucide";

const SET = {
  home: House, schedule: CalendarDays, money: Wallet, selections: Images, site: HardHat, files: FolderOpen,
  plus: Plus, download: Download, pencil: Pencil, cart: ShoppingCart, clip: Paperclip, file: FileText,
  sliders: SlidersHorizontal, hammer: Hammer, calendarClock: CalendarClock, alert: TriangleAlert, notebook: NotebookPen,
  shield: ShieldCheck, users: Users, receipt: Receipt, landmark: Landmark, truck: Truck, clipboard: ClipboardList,
  help: CircleHelp, layers: Layers, chart: ChartColumn, chartLine: ChartLine, list: ListChecks, swap: ArrowLeftRight,
  building: Building2, userPlus: UserPlus, logout: LogOut, upload: Upload, clock: Clock, wallet: Wallet,
  // selection types
  Lighting: Lightbulb, "Plumbing fixtures": ShowerHead, Appliances: Refrigerator, Tile: LayoutGrid, Flooring: LayoutGrid,
  Cabinets: PanelsTopLeft, Countertops: Square, Hardware: Wrench, "Paint & finishes": PaintRoller,
  "Doors & windows": DoorOpen, "Exterior & lanai": Trees, Other: Package,
};

const el = ([tag, attrs, kids]) =>
  `<${tag} ${Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(" ")}>${(kids || []).map(el).join("")}</${tag}>`;

export function icon(name, cls = "ic") {
  const node = SET[name];
  if (!node) return "";
  const kids = node[2] || [];
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${kids.map(el).join("")}</svg>`;
}
export const hasIcon = (name) => !!SET[name];
