terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = var.project_name
  azs         = slice(data.aws_availability_zones.available.names, 0, var.public_subnet_count)
  efs_enabled = var.enable_efs_runtime_storage
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public-rt"
  }
}

resource "aws_subnet" "public" {
  for_each = {
    for idx, az in local.azs : idx => az
  }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.key)
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${each.key + 1}"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks"
  description = "Ingress to customer runtime containers"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = var.runtime_container_port
    to_port     = var.runtime_container_port
    protocol    = "tcp"
    cidr_blocks = var.runtime_ingress_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-ecs-tasks"
  }
}

resource "aws_security_group" "efs" {
  count = local.efs_enabled ? 1 : 0

  name        = "${local.name_prefix}-efs"
  description = "NFS access for ECS tasks to persistent OpenClaw state"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-efs"
  }
}

resource "aws_efs_file_system" "runtime" {
  count = local.efs_enabled ? 1 : 0

  creation_token   = "${local.name_prefix}-openclaw-runtime"
  performance_mode = var.efs_performance_mode
  throughput_mode  = var.efs_throughput_mode
  encrypted        = true

  tags = {
    Name = "${local.name_prefix}-openclaw-runtime"
  }
}

resource "aws_efs_mount_target" "runtime" {
  for_each = local.efs_enabled ? aws_subnet.public : {}

  file_system_id  = aws_efs_file_system.runtime[0].id
  subnet_id       = each.value.id
  security_groups = [aws_security_group.efs[0].id]
}

resource "aws_efs_access_point" "runtime" {
  count = local.efs_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.runtime[0].id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/oneclick"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = {
    Name = "${local.name_prefix}-openclaw-runtime"
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecr_repository" "openclaw" {
  name                 = "${local.name_prefix}-openclaw"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

data "aws_iam_policy_document" "ecs_task_execution_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name_prefix}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name_prefix}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
}

output "aws_region" {
  value = var.aws_region
}

output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_subnet_ids_csv" {
  value = join(",", [for s in aws_subnet.public : s.id])
}

output "ecs_security_group_ids_csv" {
  value = aws_security_group.ecs_tasks.id
}

output "ecs_execution_role_arn" {
  value = aws_iam_role.ecs_execution.arn
}

output "ecs_task_role_arn" {
  value = aws_iam_role.ecs_task.arn
}

output "ecs_log_group" {
  value = aws_cloudwatch_log_group.ecs.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.openclaw.repository_url
}

output "app_env_recommended" {
  value = {
    DEPLOY_PROVIDER            = "ecs"
    DEPLOY_QUEUE_PROVIDER      = "sqs"
    AWS_REGION                 = var.aws_region
    SQS_DEPLOYMENT_QUEUE_URL   = aws_sqs_queue.deployments.url
    ECS_CLUSTER                = aws_ecs_cluster.main.name
    ECS_SUBNET_IDS             = join(",", [for s in aws_subnet.public : s.id])
    ECS_SECURITY_GROUP_IDS     = aws_security_group.ecs_tasks.id
    ECS_EXECUTION_ROLE_ARN     = aws_iam_role.ecs_execution.arn
    ECS_TASK_ROLE_ARN          = aws_iam_role.ecs_task.arn
    ECS_LOG_GROUP              = aws_cloudwatch_log_group.ecs.name
    ECS_LOG_STREAM_PREFIX      = var.ecs_log_stream_prefix
    ECS_ASSIGN_PUBLIC_IP       = "true"
    ECS_SERVICE_PREFIX         = var.ecs_service_prefix
    OPENCLAW_CONTAINER_PORT    = tostring(var.runtime_container_port)
    ECS_EFS_FILE_SYSTEM_ID     = local.efs_enabled ? aws_efs_file_system.runtime[0].id : ""
    ECS_EFS_ACCESS_POINT_ID    = local.efs_enabled ? aws_efs_access_point.runtime[0].id : ""
    ECS_EFS_TRANSIT_ENCRYPTION = "ENABLED"
  }
}
