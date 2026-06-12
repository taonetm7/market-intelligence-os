This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Seeding the database

Populate the local SQLite database (`prisma/dev.db`) with the sample dataset (5 candidate examples with raw signals, evidence, and computed scores):

```bash
pnpm seed
```

The seed runner uses Node's built-in TypeScript execution, so **Node.js >= 22.9.0 is required** (it relies on `--experimental-transform-types`, added in 22.7.0, and `--env-file-if-exists`, added in 22.9.0). This is enforced via the `engines` field in `package.json`, and the `seed` script performs an up-front version check that exits with a clear message on older runtimes. The seed is idempotent — re-running it clears and re-inserts the data rather than duplicating it.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
