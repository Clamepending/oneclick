locals {
  sqs_consumer_lambda_name = "${local.name_prefix}-sqs-deploy-consumer"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sqs_deploy_consumer_lambda" {
  count = var.enable_sqs_deploy_consumer_lambda ? 1 : 0

  name               = "${local.sqs_consumer_lambda_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sqs_deploy_consumer_lambda_basic" {
  count = var.enable_sqs_deploy_consumer_lambda ? 1 : 0

  role       = aws_iam_role.sqs_deploy_consumer_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "sqs_deploy_consumer_lambda_inline" {
  statement {
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.deployments.arn]
  }

  statement {
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:CreateService",
      "ecs:UpdateService",
      "ecs:DeleteService",
      "ecs:DescribeServices",
    ]
    resources = ["*"]
  }

  statement {
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.ecs_execution.arn,
      aws_iam_role.ecs_task.arn,
    ]
  }
}

resource "aws_iam_role_policy" "sqs_deploy_consumer_lambda_inline" {
  count = var.enable_sqs_deploy_consumer_lambda ? 1 : 0

  name   = "${local.sqs_consumer_lambda_name}-inline"
  role   = aws_iam_role.sqs_deploy_consumer_lambda[0].id
  policy = data.aws_iam_policy_document.sqs_deploy_consumer_lambda_inline.json
}

resource "aws_lambda_function" "sqs_deploy_consumer" {
  count = var.enable_sqs_deploy_consumer_lambda ? 1 : 0

  function_name = local.sqs_consumer_lambda_name
  role          = aws_iam_role.sqs_deploy_consumer_lambda[0].arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  timeout       = var.sqs_deploy_consumer_lambda_timeout_seconds
  memory_size   = var.sqs_deploy_consumer_lambda_memory_mb

  filename         = "${path.module}/../../dist/lambda/sqs-deploy-consumer.zip"
  source_code_hash = filebase64sha256("${path.module}/../../dist/lambda/sqs-deploy-consumer.zip")

  environment {
    variables = {
      NODE_ENV                 = "production"
      DEPLOY_PROVIDER          = "ecs"
      DEPLOY_QUEUE_PROVIDER    = "sqs"
      SQS_DEPLOYMENT_QUEUE_URL = aws_sqs_queue.deployments.url
      ECS_CLUSTER              = aws_ecs_cluster.main.name
      ECS_SUBNET_IDS           = join(",", [for s in aws_subnet.public : s.id])
      ECS_SECURITY_GROUP_IDS   = aws_security_group.ecs_tasks.id
      ECS_EXECUTION_ROLE_ARN   = aws_iam_role.ecs_execution.arn
      ECS_TASK_ROLE_ARN        = aws_iam_role.ecs_task.arn
      ECS_LOG_GROUP            = aws_cloudwatch_log_group.ecs.name
      ECS_LOG_STREAM_PREFIX    = var.ecs_log_stream_prefix
      ECS_ASSIGN_PUBLIC_IP     = "true"
      ECS_SERVICE_PREFIX       = var.ecs_service_prefix
      OPENCLAW_CONTAINER_PORT  = tostring(var.runtime_container_port)
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.sqs_deploy_consumer_lambda_basic,
    aws_iam_role_policy.sqs_deploy_consumer_lambda_inline,
  ]
}

resource "aws_lambda_event_source_mapping" "sqs_deployments" {
  count = var.enable_sqs_deploy_consumer_lambda ? 1 : 0

  event_source_arn = aws_sqs_queue.deployments.arn
  function_name    = aws_lambda_function.sqs_deploy_consumer[0].arn
  batch_size       = 1
  enabled          = true
}

output "sqs_deploy_consumer_lambda_name" {
  value = var.enable_sqs_deploy_consumer_lambda ? aws_lambda_function.sqs_deploy_consumer[0].function_name : null
}
