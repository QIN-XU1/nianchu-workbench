import { Page, Section, Empty } from '../components/ui';
import { snapshot } from '../data';

export default function Tasks() {
  return (
    <Page>
      <Section title="任务与派单" desc="定时任务、派单、执行记录都在后端。界面先占位，不拿假任务填充。">
        {snapshot.tasks.length === 0
          ? <Empty title="还没有任务" detail="需要接入调度器（cron + 派单台账）后才会出现条目。当前 0 条。" />
          : null}
      </Section>
      <Section title="为什么这里是空的">
        <p className="vp-sec__p">
          任务的数据源是后端调度器，不是本地快照。在接入之前，这个场景保持空态 ——
          空白是真实状态，塞几条演示任务才是假的。
        </p>
      </Section>
    </Page>
  );
}
