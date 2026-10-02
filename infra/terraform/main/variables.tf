variable "region" {
  type    = string
  default = "us-east-1" # I4
}

variable "availability_zone" {
  type    = string
  default = "us-east-1a" # offers both instance types below
}

variable "instance_type" {
  description = "m7i-flex.xlarge for development; m7i.2xlarge for the exit test (I8). Changing it stops and restarts the host."
  type        = string
  default     = "m7i-flex.xlarge"
}

variable "root_volume_gb" {
  type    = number
  default = 30
}

variable "data_volume_gb" {
  type    = number
  default = 50
}

variable "open_node_b_port" {
  description = "Open the second gateway's port (8444). Only while node b is enabled for tests (threat model G-07)."
  type        = bool
  default     = false
}

variable "autostop_enabled" {
  description = "Stop the host every night at 02:00 India time (I17). `bin/host autostop off` disables it for long runs."
  type        = bool
  default     = true
}

variable "budget_email" {
  description = "Where the monthly cost alert goes. Empty means no budget is created."
  type        = string
  default     = ""
}

variable "budget_usd" {
  type    = number
  default = 60
}
