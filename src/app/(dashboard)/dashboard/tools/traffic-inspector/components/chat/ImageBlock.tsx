"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

interface ImageBlockProps {
  url: string;
}

/**
 * Thumbnail for an image the client sent. Signed links (S3/R2 presigned URLs) often
 * expire within hours and a truncated base64 payload never decodes, so a failed load
 * falls back to a short note instead of a broken-image icon. The referrer is withheld
 * so the image host doesn't learn the dashboard's URL.
 */
export function ImageBlock({ url }: ImageBlockProps) {
  const t = useTranslations("trafficInspector");
  const [failed, setFailed] = useState(false);
  const isLink = /^https?:\/\//i.test(url);

  if (failed) {
    return (
      <div className="text-xs text-text-muted italic px-1 py-0.5 break-all">
        {t("imageUnavailable")}
        {isLink && (
          <>
            {" "}
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
              {t("imageOpenLink")}
            </a>
          </>
        )}
      </div>
    );
  }

  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary client-supplied URLs; next/image needs allow-listed hosts
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="max-h-64 max-w-full rounded border border-border object-contain"
    />
  );
  return isLink ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
      {img}
    </a>
  ) : (
    img
  );
}
