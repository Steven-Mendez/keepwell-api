import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs"

import type { Job, JobQueue } from "../../core/ports/job-queue"

export class SqsJobQueue implements JobQueue {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({})
  ) {}

  async enqueue(job: Job): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }))
  }
}

/** Development and tests: runs the job right away, in the same process. */
export class InlineJobQueue implements JobQueue {
  readonly jobs: Job[] = []
  constructor(private readonly run?: (job: Job) => Promise<unknown>) {}

  async enqueue(job: Job): Promise<void> {
    this.jobs.push(job)
    await this.run?.(job)
  }
}
