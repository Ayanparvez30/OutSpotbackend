// schedulers/midnightChallengeScheduler.js
// Production scheduler for midnight challenge notifications

const cron = require('node-cron');
const { notifyUsersAboutMidnightChallenges } = require('../utils/midnightChallengeNotifier');
const { resolveZone } = require('../utils/challenges');

/**
 * Production scheduler for midnight challenge notifications
 * This runs at midnight in different timezones to notify users about new challenges
 */
class MidnightChallengeScheduler {
  constructor() {
    this.scheduledJobs = new Map();
    this.isRunning = false;
  }

  /**
   * Start the scheduler with timezone-specific cron jobs
   */
  start() {
    if (this.isRunning) {
      console.log('⚠️  Midnight challenge scheduler is already running');
      return;
    }

    console.log('🌙 Starting midnight challenge notification scheduler...');

    // One schedule only. `User` has no timezone column, so every user's
    // challenge window is the app timezone — running a cron per US timezone
    // notified *every* user once per zone, and the "already notified" guard
    // could not catch it because each zone computes a different window start.
    const appZone = resolveZone(null);
    const timezoneSchedules = [
      {
        name: 'App timezone',
        timezone: appZone,
        cron: '0 0 0 * * *', // midnight in the app timezone
        description: `Midnight ${appZone}`
      }
    ];

    // Schedule each timezone
    timezoneSchedules.forEach(schedule => {
      const task = cron.schedule(schedule.cron, async () => {
        console.log(`\n🌙 [${new Date().toISOString()}] Running midnight notifications for ${schedule.name}`);
        
        try {
          const result = await notifyUsersAboutMidnightChallenges(schedule.timezone);
          
          if (result.success) {
            console.log(`✅ ${schedule.name} notifications completed:`);
            console.log(`   • Users processed: ${result.usersProcessed}`);
            console.log(`   • Daily notifications: ${result.dailyNotifications}`);
            console.log(`   • Weekly notifications: ${result.weeklyNotifications}`);
            console.log(`   • Total notifications: ${result.totalNotifications}`);
          } else {
            console.error(`❌ ${schedule.name} notifications failed:`, result.error);
          }
        } catch (error) {
          console.error(`❌ Error in ${schedule.name} midnight notifications:`, error);
        }
      }, {
        scheduled: false, // Don't start immediately
        timezone: schedule.timezone
      });

      this.scheduledJobs.set(schedule.timezone, {
        task,
        schedule,
        isActive: false
      });

      console.log(`📅 Scheduled ${schedule.name}: ${schedule.cron} (${schedule.description})`);
    });

    // Start all scheduled jobs
    this.scheduledJobs.forEach((job, timezone) => {
      job.task.start();
      job.isActive = true;
      console.log(`🟢 Started scheduler for ${timezone}`);
    });

    this.isRunning = true;
    console.log(`🎯 Midnight challenge scheduler started with ${this.scheduledJobs.size} timezone schedules\n`);

    // Log next execution times
    this.logNextExecutions();
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️  Midnight challenge scheduler is not running');
      return;
    }

    console.log('🛑 Stopping midnight challenge scheduler...');

    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive) {
        job.task.stop();
        job.isActive = false;
        console.log(`🔴 Stopped scheduler for ${timezone}`);
      }
    });

    this.isRunning = false;
    console.log('✅ Midnight challenge scheduler stopped');
  }

  /**
   * Get the status of all scheduled jobs
   */
  getStatus() {
    const status = {
      isRunning: this.isRunning,
      totalJobs: this.scheduledJobs.size,
      activeJobs: 0,
      schedules: []
    };

    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive) status.activeJobs++;
      
      status.schedules.push({
        timezone,
        name: job.schedule.name,
        cron: job.schedule.cron,
        description: job.schedule.description,
        isActive: job.isActive
      });
    });

    return status;
  }

  /**
   * Log when the next executions will happen
   */
  logNextExecutions() {
    console.log('⏰ Next scheduled executions:');
    
    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive && job.task.getTasks) {
        // Note: node-cron doesn't provide a direct way to get next execution time
        // This is a simplified display
        console.log(`   • ${job.schedule.name}: ${job.schedule.cron} (${job.schedule.description})`);
      }
    });
    console.log('');
  }

  /**
   * Manually trigger notifications for a specific timezone (for testing)
   */
  async triggerForTimezone(timezone) {
    console.log(`🧪 Manually triggering notifications for timezone: ${timezone}`);
    
    try {
      const result = await notifyUsersAboutMidnightChallenges(timezone);
      
      if (result.success) {
        console.log(`✅ Manual trigger completed for ${timezone}:`);
        console.log(`   • Users processed: ${result.usersProcessed}`);
        console.log(`   • Daily notifications: ${result.dailyNotifications}`);
        console.log(`   • Weekly notifications: ${result.weeklyNotifications}`);
        console.log(`   • Total notifications: ${result.totalNotifications}`);
      } else {
        console.error(`❌ Manual trigger failed for ${timezone}:`, result.error);
      }
      
      return result;
    } catch (error) {
      console.error(`❌ Error in manual trigger for ${timezone}:`, error);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
const midnightChallengeScheduler = new MidnightChallengeScheduler();

module.exports = {
  MidnightChallengeScheduler,
  midnightChallengeScheduler
};

// If running this file directly, start the scheduler
if (require.main === module) {
  console.log('🚀 Starting midnight challenge scheduler from command line...\n');
  
  midnightChallengeScheduler.start();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    midnightChallengeScheduler.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    midnightChallengeScheduler.stop();
    process.exit(0);
  });
}