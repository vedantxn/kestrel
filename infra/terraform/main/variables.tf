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

variable "enable_runner" {
  description = "Create the benchmark runner (runner.tf). Destroy it after a run by applying without it."
  type        = bool
  default     = false
}

variable "runner_proxy_port" {
  description = "When above 0, the runner accepts TCP on this port from the host's Elastic IP only, for the test proxy of the upstream-proxy check (bench proxy). 0 keeps the runner outbound-only."
  type        = number
  default     = 0
}

variable "runner_instance_type" {
  description = "Fixed-performance, so results repeat (HLD 13.3: no burstable CPU credits)."
  type        = string
  default     = "c7i.large"
}

variable "nested_virtualization" {
  description = "Expose KVM inside the host (needed by the microVM runtime, experiment V7)."
  type        = bool
  default     = true
}
