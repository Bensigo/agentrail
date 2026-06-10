import { SkeletonTable } from "../../../../components/loading-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      <section>
        <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
          Members
        </h1>
        <SkeletonTable columns={4} rows={5} />
      </section>
    </div>
  );
}
