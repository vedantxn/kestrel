terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Bucket and key come from backend.hcl, which `bin/tf` generates from the account id.
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "kestrel"
      ManagedBy = "terraform"
      Stack     = "main"
    }
  }
}

data "aws_caller_identity" "current" {}
