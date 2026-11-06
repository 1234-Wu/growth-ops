import { Workspace } from "@/components/workspace";
import { resourceNames } from "@/lib/resources";
export function generateStaticParams() { return ['dashboard', 'reconciliation', 'settings', ...resourceNames].map(module => ({ module })); }
export const dynamicParams = false;
export default async function Page({ params }: { params: Promise<{ module: string }> }) { const { module } = await params; return <Workspace initialRoute={module} />; }
