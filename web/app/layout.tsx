import type { Metadata } from "next";
import "./globals.css";
import "./design-system.css";
import "./theme-dark.css";
export const metadata: Metadata = { title: "Growth Notes · 增长运营工作台", description: "记录动作，追踪结果，沉淀每一次运营经验。" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
 return <html lang="zh-CN" className="dark" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
