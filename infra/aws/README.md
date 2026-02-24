# AWS ECS Bootstrap (One-Time Base Infra)

This Terraform stack creates the one-time AWS infrastructure needed for `DEPLOY_PROVIDER=ecs`:

- VPC + public subnets + internet gateway
- ECS cluster (Fargate)
- Security group for customer runtimes
- IAM roles for ECS task execution + task role
- CloudWatch log group
- ECR repository

It outputs the exact environment variables your app expects.

## Fastest path

1. Export AWS credentials in your shell (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`)
2. Run from repo root:

```bash
npm run aws:bootstrap
```

3. Copy generated values from `.env.aws-ecs` into your app env (`.env.local`, Vercel env, etc.).

## Notes

- This stack intentionally uses public subnets + public IPs for simplicity/minimal setup.
- You can add ALB/Route53 later after the basic ECS deploy path is working.
- `terraform.tfvars` is git-ignored by default.
