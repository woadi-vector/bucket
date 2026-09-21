import { createStart, createMiddleware, createCsrfMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// saveBucketState writes storage keyed by the visitor's cookie, so without an origin
// check another site could POST to it and overwrite someone's buckets. Low stakes on
// throwaway demo data, but there is no reason to leave a cookie-authenticated write open.
//
// The default only accepts Sec-Fetch-Site: same-origin, which 403s the document request:
// a top-level navigation sends `none`. `none` means the user typed the URL or opened a
// bookmark and cannot be produced by another site, so accepting it is safe -- a cross-site
// form POST arrives as `cross-site`.
export const startInstance = createStart(() => ({
  requestMiddleware: [
    errorMiddleware,
    createCsrfMiddleware({ secFetchSite: ["same-origin", "none"] }),
  ],
}));
