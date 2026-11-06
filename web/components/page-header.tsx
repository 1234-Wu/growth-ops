import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

export function PageHeader({ title, description, eyebrow, count, actions, icon }: {
 title: string; description: string; eyebrow?: string; count?: number; actions?: ReactNode; icon?: ReactNode;
}) {
 return <header className="page-heading">
  <div className="page-heading-copy">
   {eyebrow && <p className="eyebrow">{eyebrow}</p>}
   <div className="page-title-row">{icon}<h1>{title}</h1>{count !== undefined && <Badge variant="secondary" className="record-count">{count} 条</Badge>}</div>
   <p className="page-description">{description}</p>
  </div>
  {actions && <div className="page-heading-actions">{actions}</div>}
 </header>;
}
