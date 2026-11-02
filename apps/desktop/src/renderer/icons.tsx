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
  SlidersHorizontal,
  TrendingUp,
  UserRound,
  Users,
  Wallet,
  Landmark,
  Truck,
  IdCard,
  FolderOpen,
  ShoppingBasket,
  NotebookPen,
  Receipt,
  FileText,
  TriangleAlert,
  LayoutDashboard,
  CalendarClock,
  PackageCheck,
  ArrowLeftRight,
  ClipboardList,
  Trash2,
  Hourglass,
  Tags,
  Calculator,
  Send,
  Factory,
  CalendarDays,
  Banknote,
  BookOpen,
  Scale,
  ChartLine,
  ChartColumn,
  Save,
  Target,
  Inbox,
} from 'lucide-react';

/** Icônes au trait des menus (la barre latérale, les fenêtres) ; les émojis restent là où il n'y en a pas. */
const MENU: Record<string, LucideIcon> = {
  Fichier: FolderOpen,
  Vente: ReceiptText,
  'Caisse et argent': Wallet,
  Stock: Boxes,
  Produits: Package,
  'Achats et fournisseurs': ShoppingCart,
  Clients: Users,
  Personnel: IdCard,
  Pilotage: TrendingUp,
  Comptabilité: BookOpenText,
  Administration: Settings,
  Aide: CircleHelp,
  // Anciens noms (titres de fenêtres déjà ouvertes)
  Trésorerie: Wallet,
  Articles: Package,
  Achats: ShoppingCart,
  Fournisseurs: Truck,
  Dépenses: HandCoins,
  Suivi: TrendingUp,
  Fiscalité: Landmark,
};

/** 0.107.0 : icônes au trait des tuiles de l'accueil (à la place des émojis, qui changent d'un PC à l'autre). */
const TILE: Record<string, LucideIcon> = {
  Vendre: ShoppingBasket,
  'Vente à crédit': NotebookPen,
  'Ma caisse': Wallet,
  'Mes factures': Receipt,
  Devis: FileText,
  Clients: Users,
  'Points d’attention': TriangleAlert,
  'Tableau de bord': LayoutDashboard,
  'Journées de caisse': CalendarClock,
  Stock: Boxes,
  'Recevoir une livraison': PackageCheck,
  'Nouveau transfert': ArrowLeftRight,
  Inventaire: ClipboardList,
  'Pertes et casse': Trash2,
  Péremptions: Hourglass,
  Produits: Package,
  Étiquettes: Tags,
  'Proposition de commande': Calculator,
  'Bons de commande': Send,
  Fournisseurs: Factory,
  Échéancier: CalendarDays,
  Dépenses: Banknote,
  Journaux: BookOpen,
  'Déclaration de TVA': Landmark,
  Rapprochement: Scale,
  'États financiers': ChartLine,
  'Rapports de ventes': ChartColumn,
  Administration: Settings,
  Sauvegardes: Save,
  'Préparer une facture': Send,
  'Mes factures envoyées': Inbox,
  'Ma journée': Target,
};

export function TileIcon({ label, fallback, size = 22 }: { label: string; fallback?: string; size?: number }) {
  const I = TILE[label];
  if (!I) return <>{fallback ?? '•'}</>;
  return <I size={size} strokeWidth={1.8} aria-hidden />;
}

export function MenuIcon({ name, fallback, size = 18 }: { name: string; fallback?: string; size?: number }) {
  const I = MENU[name];
  if (!I) return <>{fallback ?? '•'}</>;
  return <I size={size} strokeWidth={1.9} aria-hidden />;
}

export const Ico = { Bell, ChevronRight, CircleHelp, House, LayoutGrid, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, SlidersHorizontal, UserRound };
