"""UTC cron fires on days 28–31; only Shanghai's final calendar day collects."""
import os
from datetime import datetime, timedelta, timezone


def is_month_end(value):
    return (value.date()+timedelta(days=1)).month != value.month


if __name__=='__main__':
    now=datetime.now(timezone(timedelta(hours=8)))
    # GitHub's creation time survives runner-queue delays and workflow re-runs.
    created=os.getenv('RUN_CREATED_AT')
    if created:
        now=datetime.fromisoformat(created.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8)))
    run=os.getenv('GITHUB_EVENT_NAME')!='schedule' or is_month_end(now)
    with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as file:
        file.write(f'run={str(run).lower()}\n')
    print(f'Shanghai schedule date {now.date()}; collect={run}')
