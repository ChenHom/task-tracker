import { registerGoalProjections } from '../src/goal';
import { registerNotificationProjections } from '../src/notification';
import { registerTaskProjections } from '../src/task';

export function initializeGoalCoordinatorProjections(): void {
  registerGoalProjections();
  registerTaskProjections();
  registerNotificationProjections();
}
