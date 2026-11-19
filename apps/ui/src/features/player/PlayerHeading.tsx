import { useState } from 'react';
import type { Subject } from '@st-vault/api-schema';
import { tr } from '../../shared/lib/i18n';
import { useSyncRefresh } from '../../shared/lib/sync';
import { CoverImage } from '../directory/CoverImage';

export function PlayerHeading({
  subject,
  siteOrigin,
}: {
  subject: Subject | null;
  siteOrigin?: string | null;
}): JSX.Element {
  const [revision, setRevision] = useState(0);
  useSyncRefresh(
    ['subjects'],
    () => {
      setRevision((value) => value + 1);
      return Promise.resolve();
    },
    !!subject,
    '',
    true,
  );
  if (!subject) return <></>;
  return (
    <>
      <div className="player-identity">
        <a
          className="player-avatar-link"
          href={
            new URL(`/${encodeURIComponent(subject.handle)}`, siteOrigin ?? 'https://stripchat.com')
              .href
          }
          target="_blank"
          rel="noreferrer"
          aria-label={`${tr('前往直播间')} · ${subject.handle}`}
        >
          <CoverImage id={subject.id} revision={revision} status="avatar" variant="avatar" />
        </a>
        <div className="player-identity-text">
          <h2 title={subject.handle}>{subject.handle}</h2>
          {!!subject?.formerNames?.length && (
            <p className="subject-former-names" title={subject.formerNames.join(' / ')}>
              {tr('曾用名')}：{subject.formerNames.join(' / ')}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
