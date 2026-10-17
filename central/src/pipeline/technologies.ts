// The technologies the catalog covers (CONTRACT: Technologies). Package URLs use the canonical `%40scope` form.
export interface Technology {
  id: string;
  name: string;
  repo: string;
  components: string[];
  /** Stable release tags; group 1 is the version. Canary and prerelease tags do not match. */
  tag: RegExp;
  /** Drops parts of a release body that are not changes (contributor credits). */
  clean: (body: string) => string;
}

const noCredits = (body: string): string => body.replace(/\n#+\s*Credits[\s\S]*$/, "");

export const TECHNOLOGIES: Record<string, Technology> = {
  next: {
    id: "next",
    name: "Next.js",
    repo: "vercel/next.js",
    components: ["pkg:npm/next"],
    tag: /^v(\d+\.\d+\.\d+)$/,
    clean: noCredits,
  },
  prisma: {
    id: "prisma",
    name: "Prisma",
    repo: "prisma/prisma",
    components: ["pkg:npm/prisma", "pkg:npm/%40prisma/client"],
    // Major 0 is Prisma Next, published under other packages.
    tag: /^v?([1-9]\d*\.\d+\.\d+)$/,
    clean: (b) => b,
    // The docs moved from content/200-orm/.../400-upgrading-to-prisma-7.mdx (where Slice 0 read it) to apps/docs.
  },
  nestjs: {
    id: "nestjs",
    name: "NestJS",
    repo: "nestjs/nest",
    components: ["pkg:npm/%40nestjs/core", "pkg:npm/%40nestjs/common"],
    tag: /^v(\d+\.\d+\.\d+)$/,
    clean: (b) => b,
  },
};

export const SINCE = "2025-10-15";
