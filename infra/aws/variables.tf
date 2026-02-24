variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix used for resource names"
  type        = string
  default     = "oneclick"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_count" {
  description = "Number of public subnets to create across AZs"
  type        = number
  default     = 2
}

variable "runtime_container_port" {
  description = "OpenClaw container port exposed by ECS tasks"
  type        = number
  default     = 18789
}

variable "runtime_ingress_cidrs" {
  description = "CIDR ranges allowed to reach customer runtimes directly"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  description = "CloudWatch log retention for ECS task logs"
  type        = number
  default     = 14
}

variable "ecs_log_stream_prefix" {
  description = "Stream prefix for awslogs in ECS task definition"
  type        = string
  default     = "oneclick"
}

variable "ecs_service_prefix" {
  description = "Prefix used by app when naming ECS services/task families"
  type        = string
  default     = "oneclick-agent"
}
