resource "aws_sqs_queue" "deployments_dlq" {
  name                      = "${local.name_prefix}-deployments-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "deployments" {
  name                       = "${local.name_prefix}-deployments"
  visibility_timeout_seconds = 900
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.deployments_dlq.arn
    maxReceiveCount     = 5
  })
}

output "sqs_deployment_queue_url" {
  value = aws_sqs_queue.deployments.url
}

output "sqs_deployment_queue_arn" {
  value = aws_sqs_queue.deployments.arn
}

output "sqs_deployment_dlq_url" {
  value = aws_sqs_queue.deployments_dlq.url
}
