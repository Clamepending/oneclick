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

variable "enable_efs_runtime_storage" {
  description = "Create EFS + access point for durable OpenClaw config/workspace on ECS tasks"
  type        = bool
  default     = true
}

variable "efs_performance_mode" {
  description = "EFS performance mode"
  type        = string
  default     = "generalPurpose"
}

variable "efs_throughput_mode" {
  description = "EFS throughput mode"
  type        = string
  default     = "bursting"
}

variable "enable_monthly_budget_alerts" {
  description = "Enable AWS Budget monthly cost alerts"
  type        = bool
  default     = false
}

variable "monthly_budget_limit_usd" {
  description = "Monthly AWS cost budget limit in USD"
  type        = number
  default     = 25
}

variable "budget_alert_email_addresses" {
  description = "Email addresses to receive AWS budget alerts"
  type        = list(string)
  default     = []
}

variable "budget_alert_threshold_percent_1" {
  description = "First budget alert threshold percentage"
  type        = number
  default     = 50
}

variable "budget_alert_threshold_percent_2" {
  description = "Second budget alert threshold percentage"
  type        = number
  default     = 80
}

variable "budget_alert_threshold_percent_3" {
  description = "Third budget alert threshold percentage"
  type        = number
  default     = 100
}
