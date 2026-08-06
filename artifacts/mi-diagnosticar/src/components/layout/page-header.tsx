import React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";

export function PageHeader({
  title,
  breadcrumb,
  action,
}: {
  title: string;
  breadcrumb: { label: string; href?: string }[];
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-[#3c8dbc] text-white px-6 py-4 flex items-center justify-between shadow-sm shrink-0">
      <div>
        <h1 className="text-2xl font-light tracking-tight mb-1.5">{title}</h1>
        <div className="flex items-center text-xs text-white/80 gap-1.5 font-medium">
          {breadcrumb.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3 h-3 opacity-60" />}
              {b.href ? (
                <Link href={b.href} className="hover:text-white transition-colors">
                  {b.label}
                </Link>
              ) : (
                <span className="text-white">{b.label}</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
