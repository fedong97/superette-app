import {
  BookOpenText,
  Bell,
  Boxes,
  ChevronRight,
  CircleHelp,
  HandCoins,
  House,
  LayoutGrid,
  type LucideIcon,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ReceiptText,
  Search,
  Settings,
  ShoppingCart,
  TrendingUp,
  UserRound,
  Users,
  Wallet,
  IdCard,
  FolderOpen,
} from 'lucide-react';

/** Icônes au trait des menus (la barre latérale, les fenêtres) ; les émojis restent là où il n'y en a pas. */
const MENU: Record<string, LucideIcon> = {
  Fichier: FolderOpen,
  Vente: ReceiptText,
  Trésorerie: Wallet,
  Stock: Boxes,
  Articles: Package,
  Achats: ShoppingCart,
  Clients: Users,
  Dépenses: HandCoins,
  Personnel: IdCard,
  Suivi: TrendingUp,
  Compta: BookOpenText,
  Administration: Settings,
  Aide: CircleHelp,
};

export function MenuIcon({ name, fallback, size = 18 }: { name: string; fallback?: string; size?: number }) {
  const I = MENU[name];
  if (!I) return <>{fallback ?? '•'}</>;
  return <I size={size} strokeWidth={1.9} aria-hidden />;
}

export const Ico = { Bell, ChevronRight, CircleHelp, House, LayoutGrid, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, UserRound };
